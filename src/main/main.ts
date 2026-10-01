import os from "node:os";
import { app, ipcMain, Menu, type IpcMainEvent, type IpcMainInvokeEvent, type WebFrameMain } from "electron";
import { SUPPORTED_PROTOCOL_VERSIONS } from "../bridge/constants.js";
import { originOf } from "../bridge/hostPolicy.js";
import { JobLog } from "../bridge/jobLog.js";
import { hasLocalNetworkPermission, LocalNetworkSuspicion } from "../bridge/localNetworkSuspicion.js";
import { frameRole } from "../bridge/navigationPolicy.js";
import { PrintBridgeHandler } from "../bridge/printBridgeHandler.js";
import { PrintService } from "../bridge/printService.js";
import { debugOrigin, shellUrlPrefix, userDataOverride } from "./config.js";
import { PosWindow } from "./posWindow.js";
import { clearStore, saveStore, storedLaunchUrl } from "./tenantStore.js";

if (userDataOverride !== null) app.setPath("userData", userDataOverride);

if (!app.requestSingleInstanceLock()) {
  // A second copy would fight the first for the printers and the window.
  app.quit();
} else {
  let pos: PosWindow | null = null;

  app.on("second-instance", () => {
    if (pos === null) return;
    if (pos.window.isMinimized()) pos.window.restore();
    pos.window.focus();
  });

  app.on("window-all-closed", () => app.quit());

  void app.whenReady().then(() => {
    // macOS keeps copy and paste in the Edit menu; nothing else is offered. Elsewhere, no menu.
    Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "editMenu" }]) : null);

    const log = new JobLog(app.getPath("userData"));
    const service = new PrintService({
      log: (entry) => log.append(entry),
      // macOS 15+ gates the store LAN behind a permission nothing can read (§8.2).
      suspicion: hasLocalNetworkPermission(process.platform, os.release()) ? new LocalNetworkSuspicion() : null,
    });
    const handler = new PrintBridgeHandler({ service, log: (entry) => log.append(entry), debugOrigin });

    // Written every run, so an empty log means a broken log rather than nothing printed, and so
    // the log names the store this till opened.
    void log.append({
      timestamp: new Date(),
      event: "launched",
      origin: originOf(storedLaunchUrl()) ?? "store_entry",
      outcome: `version ${app.getVersion()} on ${process.platform}`,
    });

    pos = new PosWindow(log);
    registerIpc(pos, handler, log);
    pos.openHome();
  });
}

function roleOf(frame: WebFrameMain | null | undefined) {
  if (!frame) return null;
  return frameRole({ url: frame.url, isMainFrame: frame.parent === null, debugOrigin, shellUrlPrefix });
}

function registerIpc(pos: PosWindow, handler: PrintBridgeHandler, log: JobLog): void {
  // Asked once per document by the preload, before the page's own scripts run.
  ipcMain.on("goopter:frame-role", (event: IpcMainEvent) => {
    const role = roleOf(event.senderFrame);
    event.returnValue =
      role === "pos"
        ? { role, version: app.getVersion(), protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] }
        : { role };
  });

  ipcMain.handle("goopter:print", (event: IpcMainInvokeEvent, envelope: unknown) => {
    const frame = event.senderFrame;
    const origin = frame ? (originOf(frame.url) ?? frame.origin ?? "null") : "null";
    const isMainFrame = frame !== null && frame !== undefined && frame.parent === null && event.sender === pos.webContents;
    return handler.handle(envelope, origin, isMainFrame);
  });

  /** The app's own screens only. A POS page that found these channels gets nothing from them. */
  const shellHandle = (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (roleOf(event.senderFrame) !== "shell") throw new Error("Not permitted.");
      return fn(event, ...args);
    });
  };

  shellHandle("shell:submit-store", (_event, raw) => {
    const url = saveStore(String(raw));
    if (url === null) {
      return { error: "That is not a store name. Enter the name before .goopter.com, for example jadegarden." };
    }
    pos.openHome();
    return { ok: true };
  });
  shellHandle("shell:retry", () => pos.openHome());
  shellHandle("shell:home", () => {
    pos.closeLog();
    pos.openHome();
  });
  shellHandle("shell:change-store", () => pos.changeStore(clearStore));
  shellHandle("shell:close-log", () => pos.closeLog());
  shellHandle("shell:read-log", async () =>
    (await log.recent(2_000)).map((entry) => ({ ...entry, timestamp: entry.timestamp.toISOString() })),
  );
}

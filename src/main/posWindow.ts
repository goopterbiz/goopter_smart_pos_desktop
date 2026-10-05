import path from "node:path";
import { BrowserWindow, dialog, powerSaveBlocker, session, app, type WebContents } from "electron";
import { isAllowed, originOf } from "../bridge/hostPolicy.js";
import type { JobLog } from "../bridge/jobLog.js";
import { decideNavigation } from "../bridge/navigationPolicy.js";
import { isPermissionGranted } from "../bridge/permissionPolicy.js";
import { kioskAtLaunch } from "../bridge/settings.js";
import { debugOrigin, preloadPath, rendererDir, windowed } from "./config.js";
import { readSettings } from "./settings.js";
import { storedLaunchUrl } from "./tenantStore.js";

/** Chromium's ERR_ABORTED: a navigation superseded by another, not a failure to report. */
const ERR_ABORTED = -3;
const MAX_PAGE_ERROR_LENGTH = 500;

const webPreferences = {
  preload: preloadPath,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
  // The dev override only. Window mode chosen at the till (C5) never opens developer tools.
  devTools: windowed,
} as const;

/**
 * The till's one window: kiosk, full screen, showing the POS (SPEC §6), unless window mode was
 * chosen from the log (C5).
 *
 * Owns the navigation policy, the load-failure screen, keeping the display awake while the POS is
 * open, and the two shortcuts that reach the app itself: Ctrl/Cmd+Shift+L for the diagnostic log
 * and Ctrl/Cmd+Shift+Q to leave kiosk mode.
 */
export class PosWindow {
  readonly window: BrowserWindow;
  private logWindow: BrowserWindow | null = null;
  /** True while the log's ⋯ menu is open, so Esc closes the menu rather than the log (C6). */
  private logMenuOpen = false;
  /** False until a POS page commits. Before then an off-allowlist page is a failed start. */
  private hasLoadedPage = false;
  private wakeLock: number | null = null;

  constructor(private readonly log: JobLog) {
    this.window = new BrowserWindow({
      kiosk: kioskAtLaunch({ windowedOverride: windowed, saved: readSettings() }),
      show: false,
      width: 1280,
      height: 800,
      backgroundColor: "#ffffff",
      autoHideMenuBar: true,
      title: "Goopter Smart POS",
      webPreferences,
    });
    this.window.once("ready-to-show", () => this.window.show());
    this.window.on("closed", () => this.releaseWakeLock());
    this.installNavigationPolicy(this.window.webContents);
    this.installShortcuts(this.window.webContents);
    this.installPageErrorLog(this.window.webContents);
  }

  get webContents(): WebContents {
    return this.window.webContents;
  }

  /** The saved store, or the store screen when there is none. */
  openHome(): void {
    const url = storedLaunchUrl();
    if (url === null) {
      this.showScreen("store.html");
      return;
    }
    this.hasLoadedPage = false;
    void this.window.loadURL(url).catch(() => undefined);
  }

  showScreen(name: "store.html" | "failure.html", query: Record<string, string> = {}): void {
    this.hasLoadedPage = false;
    this.releaseWakeLock();
    void this.window.loadFile(path.join(rendererDir, name), { query }).catch(() => undefined);
  }

  showFailure(url: string, error: string): void {
    this.showScreen("failure.html", { url, error });
  }

  /**
   * Kiosk or an ordinary window, at once, with no restart (C5). The log, where the mode is chosen,
   * is closed first. It is a modal child that blocks input to this window: on Linux the full screen
   * window can cover it and the POS then ignores the mouse, and on macOS a window with a sheet
   * attached neither enters nor leaves full screen. A log that does not close within a second
   * delays the change rather than dropping it.
   */
  setKiosk(value: boolean): void {
    const log = this.logWindow;
    if (log === null) {
      this.window.setKiosk(value);
      return;
    }
    let timer: NodeJS.Timeout;
    const apply = () => {
      clearTimeout(timer);
      log.removeListener("closed", apply);
      this.window.setKiosk(value);
    };
    timer = setTimeout(apply, 1_000);
    log.once("closed", apply);
    log.close();
  }

  setLogMenuOpen(open: boolean): void {
    this.logMenuOpen = open;
  }

  openLog(): void {
    if (this.logWindow !== null) {
      this.logWindow.focus();
      return;
    }
    this.logWindow = new BrowserWindow({
      parent: this.window,
      modal: true,
      width: 960,
      height: 720,
      title: "Diagnostic log",
      autoHideMenuBar: true,
      webPreferences,
    });
    this.logWindow.on("closed", () => {
      this.logWindow = null;
      this.logMenuOpen = false;
    });
    this.logWindow.webContents.on("before-input-event", (event, input) => {
      // With the menu open the page gets the key and closes the menu.
      if (input.type === "keyDown" && input.key === "Escape" && !this.logMenuOpen) {
        event.preventDefault();
        this.closeLog();
      }
    });
    this.logWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    this.logWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void this.logWindow.loadFile(path.join(rendererDir, "log.html")).catch(() => undefined);
  }

  closeLog(): void {
    this.logWindow?.close();
  }

  /**
   * Change Store: forget the store and its signed-in session, so the next one starts clean. The
   * POS page is unloaded first, so it cannot write its cookies or storage back after the clear.
   */
  async changeStore(clear: () => void): Promise<void> {
    clear();
    this.closeLog();
    this.hasLoadedPage = false;
    this.releaseWakeLock();
    await this.window.loadFile(path.join(rendererDir, "store.html")).catch(() => undefined);
    await session.defaultSession.clearStorageData().catch(() => undefined);
  }

  private installNavigationPolicy(contents: WebContents): void {
    const apply = (event: Electron.Event, url: string, isMainFrame: boolean) => {
      // The app's own screens are loaded by the main process, never navigated to by a page.
      const decision = decideNavigation({
        url, isMainFrame, hasGesture: false, hasLoadedPage: this.hasLoadedPage, debugOrigin,
      });
      if (decision === "load") return;
      event.preventDefault();
      // Nothing is handed to the system browser: a blocked navigation stays blocked.
      if (decision === "refuseStart") this.showFailure(url, "This address is not a Goopter store.");
    };

    contents.on("will-navigate", (event) => apply(event, event.url, true));
    contents.on("will-redirect", (event) => apply(event, event.url, event.isMainFrame));
    contents.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame) apply(event, event.url, false);
    });

    // New windows are refused and nothing opens in the system browser. Odoo's kiosk launcher
    // (goopter_kiosk_core open_url.js) then falls back to loading the page in this window.
    contents.setWindowOpenHandler(() => ({ action: "deny" }));

    contents.on("did-navigate", (_event, url) => {
      if (isAllowed(url, debugOrigin)) {
        this.hasLoadedPage = true;
        this.holdWakeLock();
      } else {
        this.releaseWakeLock();
      }
    });

    // Without this a dead network shows a blank screen.
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED || url.startsWith("file:")) return;
      this.showFailure(url, `${description} (${code})`);
    });

    contents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") return;
      this.showFailure(contents.getURL(), `The page stopped (${details.reason}).`);
    });

    // Permissions (camera, clipboard, ...) for the POS itself, notifications refused everywhere (C2).
    const ses = contents.session;
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      callback(
        isPermissionGranted({ permission, url: details.requestingUrl, isMainFrame: details.isMainFrame, debugOrigin }),
      );
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      return isPermissionGranted({ permission, url: requestingOrigin, isMainFrame: details.isMainFrame, debugOrigin });
    });
  }

  private installShortcuts(contents: WebContents): void {
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || !input.shift || !(input.control || input.meta)) return;
      const key = input.key.toLowerCase();
      if (key === "l") {
        event.preventDefault();
        this.openLog();
      } else if (key === "q") {
        event.preventDefault();
        void this.confirmQuit();
      }
    });
  }

  private async confirmQuit(): Promise<void> {
    const { response } = await dialog.showMessageBox(this.window, {
      type: "question",
      buttons: ["Cancel", "Quit"],
      defaultId: 0,
      cancelId: 0,
      message: "Quit Goopter Smart POS?",
      detail: "The till stops showing the point of sale until the app is opened again.",
    });
    if (response === 1) app.quit();
  }

  /**
   * Uncaught errors and console.error from the POS page (SPEC §11). There is no console anyone at
   * a till can reach, so without this an error inside the POS looks like a POS that did nothing.
   */
  private installPageErrorLog(contents: WebContents): void {
    contents.on("console-message", (event) => {
      if (event.level !== "error") return;
      const url = event.frame?.url ?? contents.getURL();
      if (!isAllowed(url, debugOrigin)) return;
      void this.log.append({
        timestamp: new Date(),
        event: "page_error",
        origin: originOf(url) ?? "unknown",
        outcome: event.message.slice(0, MAX_PAGE_ERROR_LENGTH),
      });
    });
  }

  /** The till must not sleep mid-transaction, so the display stays on while the POS is open. */
  private holdWakeLock(): void {
    if (this.wakeLock === null) this.wakeLock = powerSaveBlocker.start("prevent-display-sleep");
  }

  private releaseWakeLock(): void {
    if (this.wakeLock !== null) powerSaveBlocker.stop(this.wakeLock);
    this.wakeLock = null;
  }
}

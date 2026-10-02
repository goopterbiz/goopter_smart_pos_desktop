import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * C5 and C6: the window mode chosen from the diagnostic log's ⋯ menu is saved, applied at once,
 * logged, and used on the next launch. The till starts in kiosk mode, without the windowed override.
 *
 * Each test continues from the state the one before it left.
 */
test.describe.configure({ mode: "serial" });

const root = path.resolve(__dirname, "../..");
let app: ElectronApplication;
let pos: Page;
let log: Page;
let userData: string;
let posServer: http.Server;

const settingsFile = () => path.join(userData, "settings.json");
const logFile = () => path.join(userData, "print-jobs.jsonl");
const logEvents = () => readFileSync(logFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));

async function launch(): Promise<{ app: ElectronApplication; pos: Page }> {
  // Without the windowed override, whatever the calling shell has set.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (pair): pair is [string, string] => pair[1] !== undefined && pair[0] !== "GOOPTER_WINDOWED",
    ),
  );
  const launched = await electron.launch({
    args: [root],
    env: {
      ...env,
      GOOPTER_DEBUG_URL: `http://127.0.0.1:${(posServer.address() as AddressInfo).port}/odoo/point-of-sale`,
      GOOPTER_USER_DATA: userData,
    },
  });
  const page = await launched.firstWindow();
  await page.waitForLoadState("load");
  return { app: launched, pos: page };
}

const posIsKiosk = (target: ElectronApplication, page: Page) =>
  target.browserWindow(page).then((win) => win.evaluate((w) => w.isKiosk()));

/**
 * What the screen shows, not just the flag. On macOS the log is a sheet on the POS window, and a
 * window with a sheet attached can change its kiosk flag without entering or leaving full screen.
 */
const posScreen = (target: ElectronApplication, page: Page) =>
  target.browserWindow(page).then((win) => win.evaluate((w) => ({ fullScreen: w.isFullScreen() })));
const logVisible = (target: ElectronApplication) =>
  target.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.getParentWindow() !== null && w.isVisible()));

/** Listeners a mode change may leave behind on the POS window and the log. */
const listenerCounts = (target: ElectronApplication) =>
  target.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const posWindow = windows.find((w) => w.getParentWindow() === null)!;
    const logWindow = windows.find((w) => w.getParentWindow() !== null);
    return {
      enter: posWindow.listenerCount("enter-full-screen"),
      leave: posWindow.listenerCount("leave-full-screen"),
      hide: logWindow?.listenerCount("hide") ?? null,
    };
  });

async function chooseMode(logPage: Page, id: "#mode-kiosk" | "#mode-window"): Promise<void> {
  await logPage.click("#more");
  await logPage.click(id);
  await expect(logPage.locator("#menu")).toBeHidden();
}

/**
 * A key press as the OS would deliver it. Playwright's own key presses skip `before-input-event`,
 * where the shortcut and the log's Esc are handled.
 */
function press(target: ElectronApplication, urlEnd: string, keyCode: string, modifiers: string[] = []): Promise<void> {
  return target.evaluate(({ webContents }, { urlEnd, keyCode, modifiers }) => {
    const contents = webContents.getAllWebContents().find((c) => c.getURL().endsWith(urlEnd));
    if (!contents) throw new Error(`No window at ${urlEnd}`);
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers: modifiers as any });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers: modifiers as any });
  }, { urlEnd, keyCode, modifiers });
}

const pressEscapeInLog = (target: ElectronApplication) => press(target, "/renderer/log.html", "Escape");

async function openLog(target: ElectronApplication): Promise<Page> {
  const opened = target.waitForEvent("window");
  await press(target, "/odoo/point-of-sale", "L", ["shift", process.platform === "darwin" ? "meta" : "control"]);
  const logPage = await opened;
  await logPage.waitForLoadState("load");
  return logPage;
}

test.beforeAll(async () => {
  posServer = await new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>pos</title><p>pos</p>");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  userData = mkdtempSync(path.join(tmpdir(), "goopter-e2e-settings-"));
  ({ app, pos } = await launch());
});

test.afterAll(async () => {
  await app?.close();
  posServer?.close();
  rmSync(userData, { recursive: true, force: true });
});

test("a till with no saved setting starts in kiosk mode", async () => {
  expect(existsSync(settingsFile())).toBe(false);
  expect(await posIsKiosk(app, pos)).toBe(true);
});

test("the log header reads ⋯, Diagnostic log, Refresh, Done, and the footer shows only the log path", async () => {
  log = await openLog(app);
  const header = await log.locator("header > *").evaluateAll((els) =>
    els.map((el) => (el.matches(".more") ? "more" : (el.textContent ?? "").trim())),
  );
  expect(header).toEqual(["more", "Diagnostic log", "Refresh", "Done"]);
  await expect(log.locator("footer button")).toHaveCount(0);
  await expect(log.locator("footer")).toHaveText(logFile());
});

test("the ⋯ menu opens from the button's left edge with Home, Change store, and Window mode", async () => {
  await expect(log.locator("#menu")).toBeHidden();
  await log.click("#more");
  await expect(log.locator("#menu")).toBeVisible();
  const [button, menu] = await Promise.all(
    ["#more", "#menu"].map((s) => log.locator(s).evaluate((el) => el.getBoundingClientRect().toJSON())),
  );
  expect(menu.left).toBe(button.left);
  expect(menu.top).toBeGreaterThanOrEqual(button.bottom);
  await expect(log.locator("#menu [role^=menuitem]")).toHaveText(["Home", "Change store…", "Kiosk", "Window"]);
  await expect(log.locator("#menu hr")).toHaveCount(1);
  await expect(log.locator("#menu")).toContainText("Window mode");
  await expect(log.locator("#menu")).toContainText("Applies now and on every launch.");
  await expect(log.locator("#mode-kiosk")).toHaveAttribute("aria-checked", "true");
  await expect(log.locator("#mode-window")).toHaveAttribute("aria-checked", "false");
});

test("Esc closes an open menu and leaves the log open", async () => {
  await pressEscapeInLog(app);
  await expect(log.locator("#menu")).toBeHidden();
  expect(log.isClosed()).toBe(false);
});

test("a click outside the menu closes it", async () => {
  await log.click("#more");
  await expect(log.locator("#menu")).toBeVisible();
  await log.click("table", { position: { x: 400, y: 10 } });
  await expect(log.locator("#menu")).toBeHidden();
});

test("shell:set-kiosk refuses anything but a boolean", async () => {
  const outcome = await log.evaluate(() =>
    (window as any).goopterShell.setKiosk(1).then(() => "resolved", () => "rejected"),
  );
  expect(outcome).toBe("rejected");
  expect(existsSync(settingsFile())).toBe(false);
  expect(await posIsKiosk(app, pos)).toBe(true);
});

test("choosing Window applies at once, saves {\"kiosk\":false}, logs it, and moves the tick", async () => {
  await log.click("#more");
  await log.click("#mode-window");
  await expect(log.locator("#menu")).toBeHidden();
  await expect.poll(() => posIsKiosk(app, pos)).toBe(false);
  if (process.platform === "darwin") await expect.poll(() => posScreen(app, pos)).toEqual({ fullScreen: false });
  await expect.poll(() => logVisible(app)).toBe(true);
  expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ kiosk: false });
  await expect.poll(() => logEvents().some((e) => e.event === "window_mode" && e.outcome === "window")).toBe(true);
  await log.click("#more");
  await expect(log.locator("#mode-window")).toHaveAttribute("aria-checked", "true");
  await expect(log.locator("#mode-kiosk")).toHaveAttribute("aria-checked", "false");
  await pressEscapeInLog(app);
});

test("Esc with the menu closed closes the log", async () => {
  await expect(log.locator("#menu")).toBeHidden();
  const closed = log.waitForEvent("close");
  await pressEscapeInLog(app);
  await closed;
});

test("a POS page has no shell API and cannot reach shell:set-kiosk", async () => {
  expect(await pos.evaluate(() => [typeof (window as any).goopterShell, typeof (window as any).require]))
    .toEqual(["undefined", "undefined"]);
  // Call the registered handler as the POS main frame would reach it, past the preload.
  const posUrl = pos.url();
  const outcome = await app.evaluate(async ({ ipcMain }, url) => {
    const handler = (ipcMain as any)._invokeHandlers.get("shell:set-kiosk");
    // An internal Electron API. Asserted here so a future Electron that renames or drops
    // `_invokeHandlers` fails this test loudly instead of letting a missing handler pass by luck.
    if (typeof handler !== "function") {
      throw new Error("ipcMain._invokeHandlers has no shell:set-kiosk handler; the internal API may have changed");
    }
    const event = { senderFrame: { url, parent: null } };
    try {
      await handler(event, true);
      return "resolved";
    } catch (error) {
      return (error as Error).message;
    }
  }, posUrl);
  expect(outcome).toBe("Not permitted.");
  expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ kiosk: false });
  expect(await posIsKiosk(app, pos)).toBe(false);
});

test("a relaunch opens windowed, and choosing Kiosk restores kiosk mode", async () => {
  await app.close();
  ({ app, pos } = await launch());
  expect(await posIsKiosk(app, pos)).toBe(false);

  log = await openLog(app);
  // Read back from disk, so the entry survives a relaunch.
  await expect(log.locator("#entries tr", { hasText: "window_mode" })).toHaveCount(1);
  await log.click("#more");
  await expect(log.locator("#mode-window")).toHaveAttribute("aria-checked", "true");
  await log.click("#mode-kiosk");
  await expect(log.locator("#menu")).toBeHidden();
  await expect.poll(() => posIsKiosk(app, pos)).toBe(true);
  if (process.platform === "darwin") await expect.poll(() => posScreen(app, pos)).toEqual({ fullScreen: true });
  await expect.poll(() => logVisible(app)).toBe(true);
  expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ kiosk: true });
  await expect.poll(() => logEvents().some((e) => e.event === "window_mode" && e.outcome === "kiosk")).toBe(true);
});

test("a mode still applies when the log's hide event never arrives (macOS sheet)", async () => {
  test.skip(process.platform !== "darwin", "The log is a sheet only on macOS.");
  const before = await listenerCounts(app);
  // The sheet still goes away; only the event that reports it is lost.
  await app.evaluate(({ BrowserWindow }) => {
    const logWindow = BrowserWindow.getAllWindows().find((w) => w.getParentWindow() !== null)! as any;
    const emit = logWindow.emit;
    logWindow.emit = function (event: string, ...args: unknown[]) {
      return event === "hide" ? false : emit.call(this, event, ...args);
    };
  });
  await chooseMode(log, "#mode-window");
  await expect.poll(() => posIsKiosk(app, pos), { timeout: 5_000 }).toBe(false);
  await expect.poll(() => posScreen(app, pos), { timeout: 5_000 }).toEqual({ fullScreen: false });
  await expect.poll(() => logVisible(app), { timeout: 5_000 }).toBe(true);
  await expect.poll(() => listenerCounts(app)).toEqual(before);
});

test("a lost full screen event still brings the log back and leaves no listener (macOS sheet)", async () => {
  test.skip(process.platform !== "darwin", "The log is a sheet only on macOS.");
  const before = await listenerCounts(app);
  await app.evaluate(({ BrowserWindow }) => {
    const posWindow = BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)! as any;
    posWindow.realEmit = posWindow.emit;
    posWindow.emit = function (event: string, ...args: unknown[]) {
      return event === "enter-full-screen" ? false : posWindow.realEmit.call(this, event, ...args);
    };
  });
  await chooseMode(log, "#mode-kiosk");
  await expect.poll(() => posIsKiosk(app, pos), { timeout: 5_000 }).toBe(true);
  await expect.poll(() => logVisible(app), { timeout: 6_000 }).toBe(true);
  expect(await listenerCounts(app)).toEqual(before);
  await app.evaluate(({ BrowserWindow }) => {
    const posWindow = BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)! as any;
    posWindow.emit = posWindow.realEmit;
  });
  // Back to an ordinary window for the next test.
  await chooseMode(log, "#mode-window");
  await expect.poll(() => posScreen(app, pos), { timeout: 5_000 }).toEqual({ fullScreen: false });
  await expect.poll(() => logVisible(app), { timeout: 5_000 }).toBe(true);
});

test("leaving kiosk into the full screen it started from shows the log at once (macOS sheet)", async () => {
  test.skip(process.platform !== "darwin", "The log is a sheet only on macOS.");
  // Full screen as the green button makes it, entered with no sheet attached.
  const closed = log.waitForEvent("close");
  await pressEscapeInLog(app);
  await closed;
  await app.evaluate(({ BrowserWindow }) => new Promise<void>((resolve) => {
    const posWindow = BrowserWindow.getAllWindows()[0]!;
    posWindow.once("enter-full-screen", () => resolve());
    posWindow.setFullScreen(true);
  }));
  log = await openLog(app);
  const before = await listenerCounts(app);

  await chooseMode(log, "#mode-kiosk");
  await expect.poll(() => posIsKiosk(app, pos)).toBe(true);
  await chooseMode(log, "#mode-window");
  await expect.poll(() => posIsKiosk(app, pos)).toBe(false);
  // Electron returns to the full screen the window had before kiosk, so there is no transition to
  // wait for, and the log must not sit hidden until a fallback.
  await expect.poll(() => logVisible(app), { timeout: 1_000 }).toBe(true);
  expect(await posScreen(app, pos)).toEqual({ fullScreen: true });
  await log.waitForTimeout(3_500);
  expect(await listenerCounts(app)).toEqual(before);
});

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const root = path.resolve(__dirname, "../..");
let app: ElectronApplication;
let pos: Page;
let userData: string;
let posServer: http.Server;
let assetVersion = 1;
let htmlDelayMs = 0;

async function launch(): Promise<{ app: ElectronApplication; pos: Page }> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined),
  );
  const launched = await electron.launch({
    args: [root],
    env: {
      ...env,
      GOOPTER_WINDOWED: "true",
      GOOPTER_DEBUG_URL: `http://127.0.0.1:${(posServer.address() as AddressInfo).port}/odoo/point-of-sale`,
      GOOPTER_USER_DATA: userData,
    },
  });
  const page = await launched.firstWindow();
  await page.waitForLoadState("load");
  return { app: launched, pos: page };
}

const shownVersion = (page: Page) => page.evaluate(() => (window as any).assetVersion as number);

function press(target: ElectronApplication, urlEnd: string, keyCode: string, modifiers: string[] = []): Promise<void> {
  return target.evaluate(({ webContents }, { urlEnd, keyCode, modifiers }) => {
    const contents = webContents.getAllWebContents().find((c) => c.getURL().endsWith(urlEnd));
    if (!contents) throw new Error(`No window at ${urlEnd}`);
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers: modifiers as any });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers: modifiers as any });
  }, { urlEnd, keyCode, modifiers });
}

async function openLog(target: ElectronApplication): Promise<Page> {
  const opened = target.waitForEvent("window");
  await press(target, "/odoo/point-of-sale", "L", ["shift", process.platform === "darwin" ? "meta" : "control"]);
  const logPage = await opened;
  await logPage.waitForLoadState("load");
  return logPage;
}

test.beforeAll(async () => {
  posServer = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/static/app.js") {
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "public, max-age=604800" });
        res.end(`window.assetVersion = ${assetVersion};`);
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache" });
        res.end('<!doctype html><title>pos</title><script src="/static/app.js"></script><p>pos</p>');
      }, htmlDelayMs);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  userData = mkdtempSync(path.join(tmpdir(), "goopter-e2e-cache-"));
  ({ app, pos } = await launch());
});

test.afterAll(async () => {
  await app?.close();
  posServer?.close();
  rmSync(userData, { recursive: true, force: true });
});

test("a static file marked fresh for a week is served from the cache within a run", async () => {
  expect(await shownVersion(pos)).toBe(1);
  assetVersion = 2;
  await pos.goto(pos.url());
  expect(await shownVersion(pos)).toBe(1);
});

test("a relaunch fetches the static file again", async () => {
  await app.close();
  ({ app, pos } = await launch());
  expect(await shownVersion(pos)).toBe(2);
});

test("Reload in the log's ⋯ menu closes the log and fetches the static file again", async () => {
  assetVersion = 3;
  const url = pos.url();
  const log = await openLog(app);
  const closed = log.waitForEvent("close");
  const reloaded = pos.waitForEvent("load");
  await log.click("#more");
  await log.click("#reload");
  await Promise.all([closed, reloaded]);
  expect(await shownVersion(pos)).toBe(3);
  expect(pos.url()).toBe(url);
});

test("Reload while the POS is still loading fetches the static file again", async () => {
  assetVersion = 4;
  htmlDelayMs = 1_000;
  const loaded = pos.waitForEvent("load");
  await app.evaluate(async ({ ipcMain }, shellUrl) => {
    const handlers = (ipcMain as any)._invokeHandlers;
    const event = { senderFrame: { url: shellUrl, parent: null } };
    await handlers.get("shell:home")(event);
    await handlers.get("shell:reload")(event);
  }, pathToFileURL(path.join(root, "renderer", "log.html")).href);
  htmlDelayMs = 0;
  await loaded;
  expect(await shownVersion(pos)).toBe(4);
});

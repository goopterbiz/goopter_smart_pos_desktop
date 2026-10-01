import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * A till with no store saved and no debug override: the app opens on the store screen, in kiosk
 * mode, and that screen gets the shell API but never the print bridge.
 */

const root = path.resolve(__dirname, "../..");
let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  userData = mkdtempSync(path.join(tmpdir(), "goopter-e2e-store-"));
  // Without the debug and windowed overrides, whatever the calling shell has set.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (pair): pair is [string, string] => pair[1] !== undefined && !["GOOPTER_DEBUG_URL", "GOOPTER_WINDOWED"].includes(pair[0]),
    ),
  );
  app = await electron.launch({ args: [root], env: { ...env, GOOPTER_USER_DATA: userData } });
  page = await app.firstWindow();
  await page.waitForLoadState("load");
});

test.afterAll(async () => {
  await app?.close();
  rmSync(userData, { recursive: true, force: true });
});

test("a till with no store opens the store screen in kiosk mode", async () => {
  expect(page.url()).toMatch(/\/renderer\/store\.html$/);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isKiosk())).toBe(true);
});

test("the store screen gets the shell API and no print bridge", async () => {
  expect(await page.evaluate(() => [typeof (window as any).goopterShell, typeof (window as any).GoopterPOS]))
    .toEqual(["object", "undefined"]);
});

test("a name that is not one label is refused and nothing is saved", async () => {
  await page.fill("#store", "evil.com");
  await page.click("button[type=submit]");
  await expect(page.locator("#error")).toContainText("That is not a store name.");
  expect(existsSync(path.join(userData, "store.json"))).toBe(false);
});

test("a pasted address is saved as its slug only", async () => {
  // The load that follows goes to the real goopter.com and is not waited for.
  await page.fill("#store", "https://JadeGarden.goopter.com/pos/ui");
  await page.click("button[type=submit]");
  await expect.poll(() => existsSync(path.join(userData, "store.json"))).toBe(true);
  expect(JSON.parse(readFileSync(path.join(userData, "store.json"), "utf8"))).toEqual({ slug: "jadegarden" });
});

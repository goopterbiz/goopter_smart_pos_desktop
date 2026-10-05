import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * The shell end to end: a real Electron window loading a local "POS" through the debug override,
 * so the bridge is exposed exactly as it would be on `https://<store>.goopter.com`.
 *
 * The page server and the iframe server listen on different ports, so the iframe is a different
 * origin, as a payment frame on the real POS would be.
 */

const root = path.resolve(__dirname, "../..");
let app: ElectronApplication;
let page: Page;
let userData: string;
let posServer: http.Server;
let frameServer: http.Server;

function serve(html: (port: number) => string): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    const port = (server.address() as AddressInfo).port;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html(port));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const portOf = (server: http.Server) => (server.address() as AddressInfo).port;

test.beforeAll(async () => {
  frameServer = await serve(() => "<!doctype html><title>frame</title><p>payment frame</p>");
  posServer = await serve(
    () => `<!doctype html><title>pos</title><iframe id="pay" src="http://127.0.0.1:${portOf(frameServer)}/"></iframe>`,
  );
  userData = mkdtempSync(path.join(tmpdir(), "goopter-e2e-"));
  app = await electron.launch({
    // The app directory, not the entry file, so `app.getVersion()` reads package.json.
    args: [root],
    env: {
      ...process.env,
      GOOPTER_DEBUG_URL: `http://127.0.0.1:${portOf(posServer)}/odoo/point-of-sale`,
      GOOPTER_USER_DATA: userData,
      GOOPTER_WINDOWED: "true",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("load");
});

test.afterAll(async () => {
  await app?.close();
  posServer?.close();
  frameServer?.close();
  rmSync(userData, { recursive: true, force: true });
});

test("GoopterPOS has the shape iOS and Android give it, and no Bluetooth bridge", async () => {
  const shape = await page.evaluate(() => {
    const api = (window as any).GoopterPOS;
    const descriptor = Object.getOwnPropertyDescriptor(window, "GoopterPOS");
    return {
      protocolVersions: api.protocolVersions,
      keys: Object.keys(api).sort(),
      printIsFunction: typeof api.print === "function",
      usbPrinting: api.usbPrinting,
      frozen: Object.isFrozen(api) && Object.isFrozen(api.protocolVersions),
      writable: descriptor?.writable,
      configurable: descriptor?.configurable,
      enumerable: descriptor?.enumerable,
      bluetooth: typeof (window as any).goopterPrinter,
      node: typeof (window as any).require,
    };
  });
  expect(shape).toEqual({
    protocolVersions: [2],
    keys: ["print", "protocolVersions", "usbPrinting", "version"],
    printIsFunction: true,
    usbPrinting: true,
    frozen: true,
    writable: false,
    configurable: false,
    enumerable: true,
    bluetooth: "undefined",
    node: "undefined",
  });
});

test("GoopterPOS cannot be replaced or modified by the page", async () => {
  const intact = await page.evaluate(() => {
    const w = window as any;
    const original = w.GoopterPOS;
    try { w.GoopterPOS = { print: () => "hijacked" }; } catch { /* strict mode */ }
    try { w.GoopterPOS.print = () => "hijacked"; } catch { /* frozen */ }
    try { w.GoopterPOS.protocolVersions.push(3); } catch { /* frozen */ }
    try { delete w.GoopterPOS; } catch { /* non-configurable */ }
    return w.GoopterPOS === original && w.GoopterPOS.protocolVersions.length === 1 && w.GoopterPOS.print !== undefined;
  });
  expect(intact).toBe(true);
});

test("a cross-origin subframe gets no bridge", async () => {
  const frame = page.frames().find((f) => f.url().includes(String(portOf(frameServer))));
  expect(frame).toBeDefined();
  expect(await frame!.evaluate(() => typeof (window as any).GoopterPOS)).toBe("undefined");
});

test("an unsupported version resolves with the §5 message", async () => {
  const response = await page.evaluate(() => (window as any).GoopterPOS.print({ protocol_version: 3 }));
  expect(response).toEqual({ successful: false, message: "This app speaks print protocol 2; the page sent 3. Update the app." });
});

test("a refused address resolves naming it", async () => {
  const response = await page.evaluate(() =>
    (window as any).GoopterPOS.print({ protocol_version: 2, printer: { host: "8.8.8.8", port: 9100 }, data_base64: "G0A=" }),
  );
  expect(response).toEqual({
    successful: false,
    message: "8.8.8.8 is not a local network address. Check the printer's IP in Odoo.",
  });
});

test("a printer name that is not installed resolves naming it", async () => {
  const response = await page.evaluate(() =>
    (window as any).GoopterPOS.print({ protocol_version: 2, printer: { name: "No Such Printer 7f3a" }, data_base64: "G0A=" }),
  );
  expect(response).toEqual({
    successful: false,
    message: 'No printer named "No Such Printer 7f3a" is installed on this computer. Check the printer name in Odoo.',
  });
});

test("a malformed call rejects", async () => {
  const outcome = await page.evaluate(() =>
    (window as any).GoopterPOS.print(null).then(
      () => "resolved",
      (error: Error) => `rejected: ${error.message}`,
    ),
  );
  expect(outcome).toBe("rejected: Malformed print call: expected a protocol 2 print envelope.");
});

test("a valid job reaches the socket and an absent printer is reported as unreachable", async () => {
  const response = await page.evaluate(() =>
    (window as any).GoopterPOS.print({ protocol_version: 2, printer: { host: "10.255.255.1", port: 9100 }, data_base64: "G0A=" }),
  );
  expect(response.successful).toBe(false);
  expect(response.message).toMatch(/^Could not reach the printer at 10\.255\.255\.1:9100\./);
});

test("the bridge survives a reload", async () => {
  await page.reload();
  await page.waitForLoadState("load");
  expect(await page.evaluate(() => (window as any).GoopterPOS?.protocolVersions)).toEqual([2]);
});

test("the log records the launch and every call, never the payload", async () => {
  const text = readFileSync(path.join(userData, "print-jobs.jsonl"), "utf8");
  const events = text.trim().split("\n").map((line) => JSON.parse(line));
  expect(events[0]).toMatchObject({ event: "launched" });
  const origin = `http://127.0.0.1:${portOf(posServer)}`;
  expect(events).toContainEqual(expect.objectContaining({ event: "rejected", origin, outcome: "unsupported_version" }));
  expect(events).toContainEqual(expect.objectContaining({ event: "rejected", origin, target: "8.8.8.8", outcome: "host_not_local" }));
  expect(events).toContainEqual(expect.objectContaining({ event: "rejected", origin, outcome: "malformed" }));
  expect(events).toContainEqual(
    expect.objectContaining({ event: "rejected", origin, target: "No Such Printer 7f3a", outcome: "printer_not_installed" }),
  );
  expect(events).toContainEqual(expect.objectContaining({ event: "bridge_call", origin, target: "10.255.255.1:9100", bytes: 2 }));
  expect(text).not.toContain("G0A=");
});

test("GOOPTER_WINDOWED=true disables kiosk (C1)", async () => {
  const win = await app.browserWindow(page);
  expect(await win.evaluate((w) => w.isKiosk())).toBe(false);
});

test("GOOPTER_WINDOWED=1 leaves kiosk on; only \"true\" disables it (C1)", async () => {
  const otherUserData = mkdtempSync(path.join(tmpdir(), "goopter-e2e-"));
  const otherApp = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      GOOPTER_DEBUG_URL: `http://127.0.0.1:${portOf(posServer)}/odoo/point-of-sale`,
      GOOPTER_USER_DATA: otherUserData,
      GOOPTER_WINDOWED: "1",
    },
  });
  try {
    const otherPage = await otherApp.firstWindow();
    await otherPage.waitForLoadState("load");
    const win = await otherApp.browserWindow(otherPage);
    expect(await win.evaluate((w) => w.isKiosk())).toBe(true);
  } finally {
    await otherApp.close();
    rmSync(otherUserData, { recursive: true, force: true });
  }
});

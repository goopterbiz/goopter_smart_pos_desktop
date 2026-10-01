import { describe, expect, it } from "vitest";
import { PrintBridgeHandler } from "../../src/bridge/printBridgeHandler.js";
import { PrintService } from "../../src/bridge/printService.js";
import { envelope, EPOCH, FakeTransport, RecordingLog } from "./support.js";

/** SPEC §3.3, §6.2: who is answered, and in what shape. Android PrintBridgeHandlerTests. */
describe("PrintBridgeHandler", () => {
  const make = (o: { debugOrigin?: string | null; log?: RecordingLog; transport?: FakeTransport } = {}) => {
    const log = o.log ?? new RecordingLog();
    const transport = o.transport ?? new FakeTransport();
    const handler = new PrintBridgeHandler({
      service: new PrintService({ transport, log: log.append, jobDeadlineMs: 5_000, connectTimeoutMs: 1_000, now: () => EPOCH }),
      log: log.append,
      debugOrigin: o.debugOrigin ?? null,
      now: () => EPOCH,
    });
    return { handler, log, transport };
  };

  it("a job resolves with the response", async () => {
    const { handler } = make();
    expect(await handler.handle(envelope(), "https://x.goopter.com", true))
      .toStrictEqual({ response: { successful: true, bytes: 8 } });
  });

  it("a refused job still resolves", async () => {
    const { handler } = make();
    expect(await handler.handle(envelope({ host: "8.8.8.8" }), "https://x.goopter.com", true)).toStrictEqual({
      response: { successful: false, message: "8.8.8.8 is not a local network address. Check the printer's IP in Odoo." },
    });
  });

  it("a malformed call rejects", async () => {
    const { handler } = make();
    for (const body of ["nonsense", null, undefined, [1, 2], 42]) {
      expect(await handler.handle(body, "https://x.goopter.com", true))
        .toStrictEqual({ error: "Malformed print call: expected a protocol 2 print envelope." });
    }
  });

  it("a subframe or foreign origin is refused, reaches no printer, and is logged", async () => {
    const { handler, log, transport } = make();
    for (const [origin, mainFrame] of [["https://x.goopter.com", false], ["https://evilgoopter.com", true], ["null", true]] as const) {
      expect(await handler.handle(envelope(), origin, mainFrame)).toStrictEqual({ error: "This page is not permitted to print." });
    }
    expect(transport.calls).toHaveLength(0);
    expect(log.entries).toEqual([
      { timestamp: EPOCH, event: "rejected", origin: "https://x.goopter.com", outcome: "origin_not_permitted" },
      { timestamp: EPOCH, event: "rejected", origin: "https://evilgoopter.com", outcome: "origin_not_permitted" },
      { timestamp: EPOCH, event: "rejected", origin: "null", outcome: "origin_not_permitted" },
    ]);
  });

  it("an origin written into the envelope is ignored", async () => {
    const { handler, log, transport } = make();
    const spoofed = { ...envelope(), origin: "https://x.goopter.com" };
    expect(await handler.handle(spoofed, "https://evilgoopter.com", true)).toHaveProperty("error");
    expect(transport.calls).toHaveLength(0);
    await handler.handle(spoofed, "https://x.goopter.com", true);
    expect(log.entries.filter((e) => e.event !== "rejected").every((e) => e.origin === "https://x.goopter.com")).toBe(true);
  });

  it("answers the debug origin only when configured", async () => {
    const debug = make({ debugOrigin: "http://localhost:8069" });
    expect(await debug.handler.handle(envelope(), "http://localhost:8069", true))
      .toStrictEqual({ response: { successful: true, bytes: 8 } });
    expect(await make().handler.handle(envelope(), "http://localhost:8069", true)).toHaveProperty("error");
  });

  it("a log that throws never breaks the bridge", async () => {
    const broken = () => { throw new Error("log unavailable"); };
    const handler = new PrintBridgeHandler({
      service: new PrintService({ transport: new FakeTransport(), log: broken, now: () => EPOCH }),
      log: broken,
      debugOrigin: null,
      now: () => EPOCH,
    });
    expect(await handler.handle(envelope(), "https://evilgoopter.com", true)).toHaveProperty("error");
    expect(await handler.handle(envelope(), "https://x.goopter.com", true))
      .toStrictEqual({ response: { successful: true, bytes: 8 } });
  });
});

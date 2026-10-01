import { describe, expect, it } from "vitest";
import { uncheckedDestination } from "../../src/bridge/destination.js";
import { failureResponse, successResponse } from "../../src/bridge/envelope.js";
import { JobFailure, MalformedCall } from "../../src/bridge/jobFailure.js";
import { LocalNetworkSuspicion } from "../../src/bridge/localNetworkSuspicion.js";
import type { LogEntry } from "../../src/bridge/logEntry.js";
import { PrinterGate } from "../../src/bridge/printerGate.js";
import { PrintService } from "../../src/bridge/printService.js";
import type { PrinterTransport } from "../../src/bridge/transport.js";
import { envelope, EPOCH, FakeTransport, flush, RecordingLog, sleep, messageOf } from "./support.js";

/** SPEC §3.3, §4.1, §5, §8.2. Android PrintServiceTests. */
describe("PrintService", () => {
  const service = (o: {
    transport?: PrinterTransport;
    gate?: PrinterGate;
    suspicion?: LocalNetworkSuspicion | null;
    deadlineMs?: number;
    log?: (entry: LogEntry) => void;
  } = {}) =>
    new PrintService({
      gate: o.gate ?? new PrinterGate(),
      transport: o.transport ?? new FakeTransport(),
      log: o.log ?? new RecordingLog().append,
      suspicion: o.suspicion ?? null,
      jobDeadlineMs: o.deadlineMs ?? 5_000,
      connectTimeoutMs: 1_000,
      now: () => EPOCH,
    });

  const unreachableAt = (host: string) =>
    new FakeTransport({ kind: "fail", failure: JobFailure.unreachable(`${host}:9100`) });

  it("a successful job reports bytes written", async () => {
    expect(await service().print(envelope(), "https://x.goopter.com")).toStrictEqual({ successful: true, bytes: 8 });
  });

  it("only a malformed call throws", async () => {
    await expect(service().print("nonsense", "o")).rejects.toThrow(MalformedCall);
    for (const body of [envelope({ version: 9 }), envelope({ host: "8.8.8.8" }), envelope({ base64: "" })]) {
      expect((await service().print(body, "o")).successful).toBe(false);
    }
  });

  it("every failure carries a non-empty message and no bytes", async () => {
    for (const body of [envelope({ version: 7 }), envelope({ host: "8.8.8.8" }), envelope({ host: "printer.local" }),
      envelope({ port: 22 }), envelope({ base64: "" })]) {
      const response = await service().print(body, "o");
      expect(response.successful).toBe(false);
      expect(messageOf(response)).toBeTruthy();
      expect("bytes" in response).toBe(false);
    }
  });

  it("rejected jobs never reach the transport", async () => {
    const transport = new FakeTransport();
    const subject = service({ transport });
    for (const body of [envelope({ version: 9 }), envelope({ host: "8.8.8.8" }), envelope({ base64: "" })]) {
      await subject.print(body, "o");
    }
    expect(transport.calls).toHaveLength(0);
  });

  it("a refused connection says the printer may be busy", async () => {
    const failure = JobFailure.connectionRefused("192.168.1.50:9100");
    const response = await service({ transport: new FakeTransport({ kind: "fail", failure }) }).print(envelope(), "o");
    expect(messageOf(response)).toBe(failure.message);
    expect(messageOf(response)).toContain("another till");
  });

  it("jobs that time out while queued never suggest the permission", async () => {
    const gate = new PrinterGate();
    const suspicion = new LocalNetworkSuspicion();
    for (const host of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) {
      const blocker = gate.run(uncheckedDestination(host, 9100), new AbortController().signal, () => sleep(300));
      await flush();
      const response = await service({ gate, suspicion, deadlineMs: 100 }).print(envelope({ host }), "o");
      await blocker;
      expect(messageOf(response)).toBe(JobFailure.queueTimedOut(`${host}:9100`).message);
    }
    expect(suspicion.isSuspected).toBe(false);
  });

  describe("§8.2 local network heuristic (macOS)", () => {
    it("several distinct unreachable printers in a row suggest the permission", async () => {
      const suspicion = new LocalNetworkSuspicion();
      const responses = [];
      for (const host of ["192.168.1.50", "192.168.1.51", "192.168.1.52"]) {
        responses.push(await service({ transport: unreachableAt(host), suspicion }).print(envelope({ host }), "o"));
      }
      expect(messageOf(responses[0])).toBe(JobFailure.unreachable("192.168.1.50:9100").message);
      expect(messageOf(responses[1])).toBe(JobFailure.unreachable("192.168.1.51:9100").message);
      expect(messageOf(responses[2])).toBe(JobFailure.unreachableMaybePermission("192.168.1.52:9100").message);
    });

    it("one printer failing repeatedly is a broken printer, not a permission", async () => {
      const suspicion = new LocalNetworkSuspicion();
      let last;
      for (let i = 0; i < 5; i += 1) {
        last = await service({ transport: unreachableAt("192.168.1.50"), suspicion }).print(envelope(), "o");
      }
      expect(messageOf(last)).toBe(JobFailure.unreachable("192.168.1.50:9100").message);
    });

    it("a success or a refusal clears it", async () => {
      for (const clearing of [new FakeTransport(),
        new FakeTransport({ kind: "fail", failure: JobFailure.connectionRefused("192.168.1.60:9100") })]) {
        const suspicion = new LocalNetworkSuspicion();
        for (const host of ["192.168.1.50", "192.168.1.51"]) {
          await service({ transport: unreachableAt(host), suspicion }).print(envelope({ host }), "o");
        }
        await service({ transport: clearing, suspicion }).print(envelope({ host: "192.168.1.60" }), "o");
        const response = await service({ transport: unreachableAt("192.168.1.52"), suspicion })
          .print(envelope({ host: "192.168.1.52" }), "o");
        expect(messageOf(response)).toBe(JobFailure.unreachable("192.168.1.52:9100").message);
      }
    });

    it("without a heuristic (Windows, Linux) the message is always the plain one", async () => {
      let last;
      for (const host of ["192.168.1.50", "192.168.1.51", "192.168.1.52", "192.168.1.53"]) {
        last = await service({ transport: unreachableAt(host), suspicion: null }).print(envelope({ host }), "o");
      }
      expect(messageOf(last)).toBe(JobFailure.unreachable("192.168.1.53:9100").message);
    });
  });

  it("the log records the job's phases", async () => {
    const log = new RecordingLog();
    await service({ log: log.append }).print(envelope(), "https://x.goopter.com");
    expect(log.entries.map((e) => e.event)).toEqual(["bridge_call", "queued", "connect", "wrote"]);
    const wrote = log.entries.at(-1)!;
    expect(wrote.target).toBe("192.168.1.50:9100");
    expect(wrote.bytes).toBe(8);
    expect(wrote.outcome).toBe("ok");
    expect(wrote.durationMs).toBeTypeOf("number");
    expect(log.entries.every((e) => e.origin === "https://x.goopter.com")).toBe(true);

    const stalled = new RecordingLog();
    await service({ transport: new FakeTransport({ kind: "connectThenHang" }), deadlineMs: 100, log: stalled.append })
      .print(envelope(), "o");
    expect(stalled.entries.at(-1)).toMatchObject({ event: "timeout", outcome: "write_stalled" });

    const refused = new RecordingLog();
    await service({
      transport: new FakeTransport({ kind: "fail", failure: JobFailure.connectionRefused("192.168.1.50:9100") }),
      log: refused.append,
    }).print(envelope(), "o");
    expect(refused.entries.at(-1)?.event).toBe("failed");
    expect(refused.entries.some((e) => e.event === "connect")).toBe(false);
  });

  it("a malformed call and a rejection are both logged", async () => {
    const log = new RecordingLog();
    await expect(service({ log: log.append }).print(null, "o")).rejects.toThrow(MalformedCall);
    await service({ log: log.append }).print(envelope({ port: 22 }), "o");
    expect(log.entries).toEqual([
      { timestamp: EPOCH, event: "rejected", origin: "o", outcome: "malformed" },
      { timestamp: EPOCH, event: "rejected", origin: "o", target: "192.168.1.50:22", outcome: "port_not_allowed" },
    ]);
  });

  it("an unexpected transport error still resolves, named by how far the job got", async () => {
    const beforeConnect: PrinterTransport = { send: async () => { throw new TypeError("unexpected"); } };
    const afterConnect: PrinterTransport = {
      send: async (_d, _t, _c, _s, onConnected) => {
        onConnected();
        throw new RangeError("unexpected");
      },
    };
    const log = new RecordingLog();
    expect(messageOf(await service({ transport: beforeConnect, log: log.append }).print(envelope(), "o")))
      .toBe(JobFailure.unreachable("192.168.1.50:9100").message);
    expect(log.entries.at(-1)).toMatchObject({ event: "failed", outcome: "internal_error" });
    expect(messageOf(await service({ transport: afterConnect }).print(envelope(), "o")))
      .toBe(JobFailure.writeStalled("192.168.1.50:9100").message);
  });

  it("a log that throws never changes the outcome", async () => {
    const broken = () => { throw new Error("log unavailable"); };
    const asyncBroken = async () => { throw new Error("log unavailable"); };
    for (const log of [broken, asyncBroken]) {
      expect(await service({ log }).print(envelope(), "o")).toStrictEqual(successResponse(8));
      expect(await service({ log }).print(envelope({ host: "8.8.8.8" }), "o"))
        .toStrictEqual(failureResponse(JobFailure.hostNotLocal("8.8.8.8")));
      await expect(service({ log }).print(null, "o")).rejects.toThrow(MalformedCall);
    }
  });
});

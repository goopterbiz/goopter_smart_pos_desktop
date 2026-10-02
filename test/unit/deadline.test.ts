import { describe, expect, it } from "vitest";
import { withDeadline } from "../../src/bridge/deadline.js";
import { uncheckedDestination } from "../../src/bridge/destination.js";
import { JobFailure } from "../../src/bridge/jobFailure.js";
import { PrinterGate } from "../../src/bridge/printerGate.js";
import { PrintService } from "../../src/bridge/printService.js";
import { assertPrinterIsFree, envelope, EPOCH, FakeTransport, flush, RecordingLog, sleep, messageOf } from "./support.js";

/** SPEC §9, Android DeadlineTests T1-T5. */
describe("Deadline", () => {
  const printer = uncheckedDestination("10.0.0.1", 9100);
  const service = (gate: PrinterGate, transport: FakeTransport, deadlineMs: number) =>
    new PrintService({
      gate, transport, log: new RecordingLog().append, jobDeadlineMs: deadlineMs, connectTimeoutMs: 5_000, now: () => EPOCH,
    });

  it("T1 returns the body's result when it finishes first", async () => {
    expect(await withDeadline(5_000, () => JobFailure.noData(), async () => 42)).toBe(42);
  });

  it("T2 throws the expiry failure, not a generic timeout", async () => {
    const failure = JobFailure.writeStalled("10.0.0.1:9100");
    await expect(withDeadline(50, () => failure, (signal) => sleep(30_000, signal).then(() => 1))).rejects.toBe(failure);
  });

  it("T3 the body is aborted on expiry and settles before the deadline returns", async () => {
    let unwound = false;
    await expect(
      withDeadline(50, () => JobFailure.noData(), async (signal) => {
        try {
          await sleep(30_000, signal);
        } finally {
          await flush();
          unwound = true;
        }
      }),
    ).rejects.toEqual(JobFailure.noData());
    expect(unwound).toBe(true);
  });

  it("a body that finished as the timer fired still reports its result", async () => {
    expect(await withDeadline(10, () => JobFailure.noData(), async () => {
      await sleep(30);
      return 7;
    })).toBe(7);
  });

  it("T4 the deadline is measured from admission, not from connect", async () => {
    const gate = new PrinterGate();
    const transport = new FakeTransport({ kind: "delay", ms: 120 });
    const blocker = gate.run(printer, new AbortController().signal, () => sleep(400));
    await flush();

    const response = await service(gate, transport, 200).print(envelope({ host: "10.0.0.1" }), "test");
    await blocker;

    expect(response.successful).toBe(false);
    expect(messageOf(response)).toBe(JobFailure.queueTimedOut("10.0.0.1:9100").message);
    expect(transport.calls).toHaveLength(0);
  });

  it("T5 expiry releases the printer lock", async () => {
    const gate = new PrinterGate();
    const response = await service(gate, new FakeTransport({ kind: "connectThenHang" }), 120)
      .print(envelope({ host: "10.0.0.1" }), "test");
    expect(messageOf(response)).toBe(JobFailure.writeStalled("10.0.0.1:9100").message);
    await assertPrinterIsFree(gate, printer);
  });

  it("expiry before connect is unreachable", async () => {
    const gate = new PrinterGate();
    const response = await service(gate, new FakeTransport({ kind: "hangBeforeConnect" }), 120)
      .print(envelope({ host: "10.0.0.1" }), "test");
    expect(messageOf(response)).toBe(JobFailure.unreachable("10.0.0.1:9100").message);
    await assertPrinterIsFree(gate, printer);
  });
});

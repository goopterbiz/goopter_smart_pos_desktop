import { describe, expect, it } from "vitest";
import { uncheckedDestination } from "../../src/bridge/destination.js";
import { PrinterGate } from "../../src/bridge/printerGate.js";
import { JobFailure } from "../../src/bridge/jobFailure.js";
import { assertPrinterIsFree, deferred, flush, sleep } from "./support.js";

/** SPEC §9, Android PrinterGateTests G1-G7. */
describe("PrinterGate", () => {
  const printerA = uncheckedDestination("10.0.0.1", 9100);
  const printerB = uncheckedDestination("10.0.0.2", 9100);
  const never = new AbortController().signal;

  it("G1 jobs to one printer do not overlap", async () => {
    const gate = new PrinterGate();
    let current = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        gate.run(printerA, never, async () => {
          current += 1;
          peak = Math.max(peak, current);
          await sleep(10);
          current -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);
  });

  it("G2 jobs to different printers overlap", async () => {
    const gate = new PrinterGate();
    const bothInside = deferred();
    let inside = 0;
    const arrive = async () => {
      inside += 1;
      if (inside === 2) bothInside.resolve();
      await bothInside.promise;
    };
    const run = Promise.all([gate.run(printerA, never, arrive), gate.run(printerB, never, arrive)]);
    await Promise.race([run, sleep(2_000).then(() => {
      throw new Error("different printers queued behind each other");
    })]);
  });

  it("jobs queued on a stalled printer do not block another printer", async () => {
    const gate = new PrinterGate(4);
    const stall = deferred();
    const stalled = Array.from({ length: 5 }, () => gate.run(printerA, never, () => stall.promise));
    await flush();
    const receipt = deferred();
    void gate.run(printerB, never, async () => receipt.resolve());
    await flush();
    expect(receipt.settled()).toBe(true);
    stall.resolve();
    await Promise.all(stalled);
  });

  it("a job aborted before its turn never enters the body", async () => {
    const gate = new PrinterGate();
    const controller = new AbortController();
    controller.abort();
    let ran = 0;
    await expect(gate.run(printerA, controller.signal, async () => { ran += 1; })).rejects.toBeDefined();
    expect(ran).toBe(0);
    await assertPrinterIsFree(gate, printerA);
  });

  it("G3 the in-flight cap admits four and holds the fifth", async () => {
    const gate = new PrinterGate(4);
    const hold = deferred();
    let inside = 0;
    const four = Array.from({ length: 4 }, (_, i) =>
      gate.run(uncheckedDestination(`10.0.0.${i + 1}`, 9100), never, async () => {
        inside += 1;
        await hold.promise;
      }),
    );
    await flush();
    expect(inside).toBe(4);

    const fifth = deferred();
    const fifthJob = gate.run(uncheckedDestination("10.0.0.99", 9100), never, async () => fifth.resolve());
    await flush();
    expect(fifth.settled()).toBe(false);

    hold.resolve();
    await Promise.all([...four, fifthJob]);
    expect(fifth.settled()).toBe(true);
  });

  it("G4 aborting a waiting job releases the lock and the job never runs", async () => {
    const gate = new PrinterGate();
    const releaseHolder = deferred();
    const holder = gate.run(printerA, never, () => releaseHolder.promise);
    await flush();

    const controller = new AbortController();
    let waiterRan = 0;
    const waiter = gate.run(printerA, controller.signal, async () => { waiterRan += 1; });
    await flush();
    controller.abort();
    await expect(waiter).rejects.toBeDefined();

    releaseHolder.resolve();
    await holder;
    expect(waiterRan).toBe(0);
    await assertPrinterIsFree(gate, printerA);
  });

  it("G5 a throwing body releases both limits", async () => {
    const gate = new PrinterGate(1);
    for (let i = 0; i < 3; i += 1) {
      await expect(gate.run(printerA, never, async () => { throw JobFailure.noData(); })).rejects.toThrow(JobFailure);
    }
    await assertPrinterIsFree(gate, printerA);
    await assertPrinterIsFree(gate, printerB);
  });

  it("G7 jobs for one printer run in arrival order", async () => {
    const gate = new PrinterGate();
    const release = deferred();
    const first = gate.run(printerA, never, () => release.promise);
    await flush();
    const order: number[] = [];
    const jobs = [1, 2, 3, 4, 5].map((n) => gate.run(printerA, never, async () => { order.push(n); }));
    release.resolve();
    await Promise.all([first, ...jobs]);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("G7 slots are handed out in arrival order", async () => {
    const gate = new PrinterGate(1);
    const release = deferred();
    const first = gate.run(printerA, never, () => release.promise);
    await flush();
    const order: number[] = [];
    const jobs = [1, 2, 3, 4, 5].map((n) =>
      gate.run(uncheckedDestination(`10.0.1.${n}`, 9100), never, async () => { order.push(n); }),
    );
    release.resolve();
    await Promise.all([first, ...jobs]);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});

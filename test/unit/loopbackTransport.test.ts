import { afterEach, describe, expect, it } from "vitest";
import { withDeadline, PhaseTracker } from "../../src/bridge/deadline.js";
import { uncheckedDestination } from "../../src/bridge/destination.js";
import { JobFailure } from "../../src/bridge/jobFailure.js";
import { PrinterGate } from "../../src/bridge/printerGate.js";
import { SocketPrinterTransport } from "../../src/bridge/transport.js";
import { assertPrinterIsFree, LoopbackListener, PAYLOAD, sleep, waitUntil } from "./support.js";

/**
 * SPEC §7, §14 loopback rows; Android LoopbackTransportTests L1-L7, G6.
 *
 * 127.0.0.1 is refused by the destination policy by design, so the transport is driven directly.
 */
describe("SocketPrinterTransport over loopback", () => {
  const transport = new SocketPrinterTransport();
  const never = () => new AbortController().signal;
  /** Larger than any socket buffer, so a send to a peer that never reads cannot complete. */
  const bulk = new Uint8Array(64 * 1024 * 1024);
  const listeners: LoopbackListener[] = [];
  const listen = async (drains = true) => {
    const listener = await LoopbackListener.start({ drains });
    listeners.push(listener);
    return listener;
  };

  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((l) => l.close()));
  });

  it("L1 writes every byte to a listener that drains", async () => {
    const listener = await listen();
    const destination = uncheckedDestination("127.0.0.1", listener.port);
    expect(await transport.send(PAYLOAD, destination, 5_000, never(), () => undefined)).toBe(PAYLOAD.length);
    await waitUntil(() => listener.received.length === PAYLOAD.length);
    expect(Uint8Array.from(listener.received)).toEqual(PAYLOAD);
  });

  it("L2 a closed port is reported as refused immediately", async () => {
    const port = await LoopbackListener.closedPort();
    const started = Date.now();
    await expect(transport.send(PAYLOAD, uncheckedDestination("127.0.0.1", port), 5_000, never(), () => undefined))
      .rejects.toEqual(JobFailure.connectionRefused(`127.0.0.1:${port}`));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("L3 connect gives up at the connect timeout", async () => {
    const started = Date.now();
    await expect(transport.send(PAYLOAD, uncheckedDestination("10.255.255.1", 9100), 300, never(), () => undefined))
      .rejects.toEqual(JobFailure.unreachable("10.255.255.1:9100"));
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("L4 onConnected fires once, before any bytes are sent", async () => {
    const listener = await listen();
    let calls = 0;
    let receivedWhenCalled = -1;
    await transport.send(PAYLOAD, uncheckedDestination("127.0.0.1", listener.port), 5_000, never(), () => {
      calls += 1;
      receivedWhenCalled = listener.received.length;
    });
    expect(calls).toBe(1);
    expect(receivedWhenCalled).toBe(0);
  });

  it("L5 onConnected does not fire when the connect fails", async () => {
    let connected = 0;
    const port = await LoopbackListener.closedPort();
    await expect(transport.send(PAYLOAD, uncheckedDestination("127.0.0.1", port), 2_000, never(), () => { connected += 1; }))
      .rejects.toBeInstanceOf(JobFailure);
    expect(connected).toBe(0);
  });

  it("L6 a listener that never drains hits the deadline and releases the lock", async () => {
    const listener = await listen(false);
    const gate = new PrinterGate();
    const destination = uncheckedDestination("127.0.0.1", listener.port);
    const phase = new PhaseTracker();
    const failure = await withDeadline(600, () => phase.expiry(destination.toString()), (signal) =>
      gate.run(destination, signal, () => {
        phase.markAttempted();
        return transport.send(bulk, destination, 5_000, signal, () => phase.markConnected(new Date()));
      }),
    ).then(() => null, (error: unknown) => error);
    expect(failure).toEqual(JobFailure.writeStalled(destination.toString()));
    await assertPrinterIsFree(gate, destination);
  });

  it("L7 aborting a stalled write resets the connection, so buffered bytes never reach the printer", async () => {
    const listener = await listen(false);
    const controller = new AbortController();
    let connected = false;
    const sending = transport.send(bulk, uncheckedDestination("127.0.0.1", listener.port), 5_000, controller.signal, () => {
      connected = true;
    });
    const peer = await listener.awaitConnection();
    await waitUntil(() => connected);
    await sleep(200);

    controller.abort();
    const outcome = await Promise.race([sending.then(() => "resolved", () => "rejected"), sleep(2_000).then(() => "hung")]);
    expect(outcome).toBe("rejected");
    // A graceful close would let the kernel keep sending what it had buffered and end with a FIN.
    // A reset ends the connection at once and the peer is told so.
    const ending = await new Promise<string>((resolve) => {
      peer.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
      peer.on("end", () => resolve("graceful end"));
      peer.resume();
    });
    expect(ending).toBe("ECONNRESET");
  });

  it("L7 aborting a connect in progress settles promptly", async () => {
    const controller = new AbortController();
    const sending = transport.send(PAYLOAD, uncheckedDestination("10.255.255.1", 9100), 30_000, controller.signal, () => undefined)
      .catch(() => undefined);
    await sleep(200);
    const started = Date.now();
    controller.abort();
    await sending;
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("an aborted send rejects with the abort reason, so the deadline names the failure", async () => {
    const listener = await listen(false);
    const controller = new AbortController();
    const reason = new Error("deadline");
    const sending = transport.send(bulk, uncheckedDestination("127.0.0.1", listener.port), 5_000, controller.signal, () => undefined);
    await listener.awaitConnection();
    controller.abort(reason);
    await expect(sending).rejects.toBe(reason);
  });

  it("an already-aborted send never dials", async () => {
    const listener = await listen();
    const controller = new AbortController();
    controller.abort();
    await expect(transport.send(PAYLOAD, uncheckedDestination("127.0.0.1", listener.port), 5_000, controller.signal, () => undefined))
      .rejects.toBeDefined();
    await sleep(100);
    expect(listener.connectionCount).toBe(0);
  });

  it("G6 concurrent jobs to one printer reach it one at a time", async () => {
    const listener = await listen();
    const gate = new PrinterGate();
    const destination = uncheckedDestination("127.0.0.1", listener.port);
    let admitted = 0;
    await Promise.all(Array.from({ length: 5 }, () =>
      gate.run(destination, never(), async () => {
        admitted += 1;
        const position = admitted;
        await transport.send(PAYLOAD, destination, 5_000, never(), () => undefined);
        await waitUntil(() => listener.endedCount >= position);
      }),
    ));
    expect(listener.connectionCount).toBe(5);
    expect(listener.overlappedConnections).toBe(1);
    expect(listener.received.length).toBe(PAYLOAD.length * 5);
  });
});

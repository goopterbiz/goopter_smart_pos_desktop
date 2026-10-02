import { describe, expect, it } from "vitest";
import { requestLocalNetworkPrompt, type UdpSocket, type UdpSocketFactory } from "../../src/bridge/localNetworkPrompt.js";
import { RecordingLog } from "./support.js";

/**
 * A fake standing in for the one `dgram.Socket` slice this module touches.
 *
 * Real dgram hands an asynchronous connect failure (e.g. ENOTFOUND) to the connect callback as its
 * own argument and emits no 'error' event for it; verified against node:dgram directly. The fake
 * must reproduce that split, or a bug that ignores the callback's error would pass here while
 * failing for real (F1/F2). `errorEvent` models a failure that does arrive as an 'error' event,
 * such as one during the socket's implicit bind.
 */
class FakeSocket implements UdpSocket {
  connectCalls: [number, string][] = [];
  closed = false;
  sendCalled = false;

  constructor(
    private readonly behaviour:
      | { kind: "succeed" }
      | { kind: "connectCallbackError"; error: NodeJS.ErrnoException }
      | { kind: "errorEvent"; error: NodeJS.ErrnoException }
      | { kind: "throwOnConnect"; error: NodeJS.ErrnoException }
      | { kind: "throwOnClose"; error: NodeJS.ErrnoException } = { kind: "succeed" },
  ) {}

  private errorListener: ((error: NodeJS.ErrnoException) => void) | null = null;

  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): void {
    if (event === "error") this.errorListener = listener;
  }

  connect(port: number, address: string, callback: (error?: NodeJS.ErrnoException) => void): void {
    this.connectCalls.push([port, address]);
    const behaviour = this.behaviour;
    if (behaviour.kind === "throwOnConnect") throw behaviour.error;
    if (behaviour.kind === "connectCallbackError") {
      queueMicrotask(() => callback(behaviour.error));
      return;
    }
    if (behaviour.kind === "errorEvent") {
      queueMicrotask(() => this.errorListener?.(behaviour.error));
      return;
    }
    queueMicrotask(() => callback());
  }

  close(callback?: () => void): void {
    this.closed = true;
    if (this.behaviour.kind === "throwOnClose") throw this.behaviour.error;
    callback?.();
  }

  /** Never wired to anything the module calls; present so a stray call fails loudly in a test. */
  send(): never {
    this.sendCalled = true;
    throw new Error("localNetworkPrompt must never send");
  }
}

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe("requestLocalNetworkPrompt", () => {
  it("connects a udp4 socket to 224.0.0.251:5353 and never sends", async () => {
    const socket = new FakeSocket();
    const log = new RecordingLog();
    const factory: UdpSocketFactory = () => socket;

    await requestLocalNetworkPrompt("darwin", "24.0.0", log.append, factory);

    expect(socket.connectCalls).toEqual([[5353, "224.0.0.251"]]);
    expect(socket.sendCalled).toBe(false);
  });

  it("closes the socket after a successful connect and logs requested", async () => {
    const socket = new FakeSocket();
    const log = new RecordingLog();

    await requestLocalNetworkPrompt("darwin", "24.0.0", log.append, () => socket);

    expect(socket.closed).toBe(true);
    expect(log.entries).toEqual([
      expect.objectContaining({ event: "local_network", origin: "app", outcome: "requested" }),
    ]);
  });

  it("logs the error code when the connect callback reports a failure, and still closes the socket", async () => {
    // F1 regression: dgram reports an async connect failure through the callback's own argument,
    // not an 'error' event. A fix that only listens for 'error' would log "requested" here.
    const socket = new FakeSocket({ kind: "connectCallbackError", error: errnoError("ENOTFOUND") });
    const log = new RecordingLog();

    await requestLocalNetworkPrompt("darwin", "24.0.0", log.append, () => socket);

    expect(socket.closed).toBe(true);
    expect(log.entries).toEqual([expect.objectContaining({ event: "local_network", outcome: "ENOTFOUND" })]);
  });

  it("logs the error code when an 'error' event arrives instead (e.g. a bind failure), and still closes", async () => {
    const socket = new FakeSocket({ kind: "errorEvent", error: errnoError("EADDRNOTAVAIL") });
    const log = new RecordingLog();

    await requestLocalNetworkPrompt("darwin", "24.0.0", log.append, () => socket);

    expect(socket.closed).toBe(true);
    expect(log.entries).toEqual([expect.objectContaining({ event: "local_network", outcome: "EADDRNOTAVAIL" })]);
  });

  it("never throws when the socket factory itself throws", async () => {
    const log = new RecordingLog();
    const factory: UdpSocketFactory = () => {
      throw errnoError("EMFILE");
    };

    await expect(requestLocalNetworkPrompt("darwin", "24.0.0", log.append, factory)).resolves.toBeUndefined();
    expect(log.entries).toEqual([expect.objectContaining({ event: "local_network", outcome: "EMFILE" })]);
  });

  it("never throws when connect() itself throws synchronously", async () => {
    const socket = new FakeSocket({ kind: "throwOnConnect", error: errnoError("ENETDOWN") });
    const log = new RecordingLog();

    await expect(requestLocalNetworkPrompt("darwin", "24.0.0", log.append, () => socket)).resolves.toBeUndefined();
    expect(log.entries).toEqual([expect.objectContaining({ event: "local_network", outcome: "ENETDOWN" })]);
  });

  it("never throws when close() itself throws", async () => {
    const socket = new FakeSocket({ kind: "throwOnClose", error: errnoError("EBADF") });
    const log = new RecordingLog();

    await expect(requestLocalNetworkPrompt("darwin", "24.0.0", log.append, () => socket)).resolves.toBeUndefined();
    expect(log.entries).toEqual([expect.objectContaining({ event: "local_network", outcome: "EBADF" })]);
  });

  it("falls back to a generic code when the failure carries none", async () => {
    const socket = new FakeSocket({ kind: "connectCallbackError", error: new Error("no code") as NodeJS.ErrnoException });
    const log = new RecordingLog();

    await requestLocalNetworkPrompt("darwin", "24.0.0", log.append, () => socket);

    expect(log.entries).toEqual([expect.objectContaining({ event: "local_network", outcome: "unknown_error" })]);
  });

  it("never runs on Windows or Linux", async () => {
    const log = new RecordingLog();
    const factory: UdpSocketFactory = () => {
      throw new Error("must not be called");
    };

    await requestLocalNetworkPrompt("win32", "10.0.26100", log.append, factory);
    await requestLocalNetworkPrompt("linux", "6.8.0", log.append, factory);

    expect(log.entries).toEqual([]);
  });

  it("never runs on macOS below 15 (Darwin 24)", async () => {
    const log = new RecordingLog();
    const factory: UdpSocketFactory = () => {
      throw new Error("must not be called");
    };

    await requestLocalNetworkPrompt("darwin", "23.6.0", log.append, factory);

    expect(log.entries).toEqual([]);
  });

  it("runs on macOS 15 and later", async () => {
    const socket = new FakeSocket();
    const log = new RecordingLog();

    await requestLocalNetworkPrompt("darwin", "25.5.0", log.append, () => socket);

    expect(socket.connectCalls).toHaveLength(1);
    expect(log.entries).toHaveLength(1);
  });
});

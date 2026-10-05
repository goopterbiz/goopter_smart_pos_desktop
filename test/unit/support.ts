import net from "node:net";
import type { Destination } from "../../src/bridge/destination.js";
import type { InstalledPrinter, PrinterDirectory } from "../../src/bridge/installedPrinter.js";
import type { SpoolerTransport } from "../../src/bridge/spoolerTransport.js";
import type { JobFailure } from "../../src/bridge/jobFailure.js";
import type { LogEntry } from "../../src/bridge/logEntry.js";
import type { PrinterTransport } from "../../src/bridge/transport.js";
import type { PrinterGate } from "../../src/bridge/printerGate.js";
import type { PrintResponse } from "../../src/bridge/envelope.js";

/** The cashier-facing message, or undefined for a success. */
export const messageOf = (response: PrintResponse | undefined): string | undefined =>
  response !== undefined && "message" in response ? response.message : undefined;

/** The test envelope: `null` omits a field, anything else replaces the default. */
export function envelope(
  overrides: { version?: unknown; host?: unknown; port?: unknown; base64?: unknown } = {},
): Record<string, unknown> {
  const pick = <T>(key: keyof typeof overrides, fallback: T): unknown =>
    key in overrides ? overrides[key] : fallback;
  const version = pick("version", 2);
  const host = pick("host", "192.168.1.50");
  const port = pick("port", 9100);
  const base64 = pick("base64", "G0BoaQodVgA=");
  const printer: Record<string, unknown> = {};
  if (host !== null) printer.host = host;
  if (port !== null) printer.port = port;
  const body: Record<string, unknown> = { printer };
  if (version !== null) body.protocol_version = version;
  if (base64 !== null) body.data_base64 = base64;
  return body;
}

/** An envelope for a printer installed on the till. `printer` replaces the printer object. */
export function namedEnvelope(printer: Record<string, unknown> = { name: "EPSON_TM_T20III" }): Record<string, unknown> {
  return { protocol_version: 2, printer, data_base64: "G0BoaQodVgA=" };
}

/** The eight bytes `G0BoaQodVgA=` decodes to. */
export const PAYLOAD = Uint8Array.from([0x1b, 0x40, 0x68, 0x69, 0x0a, 0x1d, 0x56, 0x00]);

export const EPOCH = new Date(0);

/** Let every queued promise continuation and I/O callback run. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; settled: () => boolean } {
  let resolve!: (value: T) => void;
  let done = false;
  const promise = new Promise<T>((r) => {
    resolve = (value) => {
      done = true;
      r(value);
    };
  });
  return { promise, resolve, settled: () => done };
}

export class RecordingLog {
  readonly entries: LogEntry[] = [];
  readonly append = (entry: LogEntry): void => {
    this.entries.push(entry);
  };
}

export type Behaviour =
  | { kind: "succeed" }
  | { kind: "fail"; failure: JobFailure }
  | { kind: "connectThenHang" }
  | { kind: "hangBeforeConnect" }
  | { kind: "delay"; ms: number };

export class FakeTransport implements PrinterTransport {
  readonly calls: Destination[] = [];

  constructor(public behaviour: Behaviour = { kind: "succeed" }) {}

  async send(
    data: Uint8Array,
    destination: Destination,
    _connectTimeoutMs: number,
    signal: AbortSignal,
    onConnected: () => void,
  ): Promise<number> {
    this.calls.push(destination);
    const behaviour = this.behaviour;
    switch (behaviour.kind) {
      case "succeed":
        onConnected();
        break;
      case "fail":
        throw behaviour.failure;
      case "connectThenHang":
        onConnected();
        await sleep(600_000, signal);
        break;
      case "hangBeforeConnect":
        await sleep(600_000, signal);
        break;
      case "delay":
        onConnected();
        await sleep(behaviour.ms, signal);
        break;
    }
    return data.length;
  }
}

export type SpoolerBehaviour = { kind: "succeed" } | { kind: "fail"; failure: JobFailure } | { kind: "hang" };

export class FakeSpooler implements SpoolerTransport {
  readonly calls: InstalledPrinter[] = [];
  readonly received: Uint8Array[] = [];

  constructor(public behaviour: SpoolerBehaviour = { kind: "succeed" }) {}

  async send(data: Uint8Array, printer: InstalledPrinter, signal: AbortSignal): Promise<number> {
    this.calls.push(printer);
    this.received.push(data);
    const behaviour = this.behaviour;
    if (behaviour.kind === "fail") throw behaviour.failure;
    if (behaviour.kind === "hang") await sleep(600_000, signal);
    return data.length;
  }
}

/** A directory listing exactly these printer names. */
export const directoryOf = (...names: string[]): PrinterDirectory => ({ list: async () => names });

/** Fails rather than hanging when the printer's lock is still held. */
export async function assertPrinterIsFree(gate: PrinterGate, destination: Destination, timeoutMs = 2_000): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timed out")), timeoutMs);
  try {
    await gate.run(destination, controller.signal, async () => undefined);
  } catch {
    throw new Error(`the printer at ${destination} is still locked`);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitUntil(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await sleep(5);
  }
}

/** A TCP listener on 127.0.0.1 that records what reaches it. */
export class LoopbackListener {
  private server: net.Server;
  private open = new Set<net.Socket>();
  private pending: ((socket: net.Socket) => void)[] = [];
  private accepted: net.Socket[] = [];
  connectionCount = 0;
  endedCount = 0;
  overlappedConnections = 0;
  received: number[] = [];

  private constructor(private readonly drains: boolean) {
    this.server = net.createServer((socket) => {
      this.connectionCount += 1;
      this.open.add(socket);
      this.overlappedConnections = Math.max(this.overlappedConnections, this.open.size);
      if (this.drains) {
        socket.on("data", (chunk: Buffer) => {
          for (const byte of chunk) this.received.push(byte);
        });
      } else {
        socket.pause();
      }
      socket.on("error", () => undefined);
      socket.on("close", () => {
        this.open.delete(socket);
        this.endedCount += 1;
      });
      const waiter = this.pending.shift();
      if (waiter) waiter(socket);
      else this.accepted.push(socket);
    });
  }

  static async start(options: { drains?: boolean } = {}): Promise<LoopbackListener> {
    const listener = new LoopbackListener(options.drains ?? true);
    await new Promise<void>((resolve) => listener.server.listen(0, "127.0.0.1", resolve));
    return listener;
  }

  get port(): number {
    return (this.server.address() as net.AddressInfo).port;
  }

  awaitConnection(timeoutMs = 2_000): Promise<net.Socket> {
    const ready = this.accepted.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no connection")), timeoutMs);
      this.pending.push((socket) => {
        clearTimeout(timer);
        resolve(socket);
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** A port nothing is listening on: bound, read, released. */
  static async closedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }
}

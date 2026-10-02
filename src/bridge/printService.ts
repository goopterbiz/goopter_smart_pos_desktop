import { CONNECT_TIMEOUT_MS, JOB_DEADLINE_MS } from "./constants.js";
import { PhaseTracker, withDeadline } from "./deadline.js";
import { failureResponse, readEnvelope, successResponse, type PrintEnvelope, type PrintResponse } from "./envelope.js";
import { JobFailure, MalformedCall } from "./jobFailure.js";
import type { LocalNetworkSuspicion } from "./localNetworkSuspicion.js";
import { safely, type LogEntry, type LogEvent, type LogSink } from "./logEntry.js";
import { PrinterGate } from "./printerGate.js";
import { SocketPrinterTransport, type PrinterTransport } from "./transport.js";

export interface PrintServiceOptions {
  gate?: PrinterGate;
  transport?: PrinterTransport;
  log: LogSink;
  /** The §8.2 heuristic. Provided on macOS only; null elsewhere. */
  suspicion?: LocalNetworkSuspicion | null;
  jobDeadlineMs?: number;
  connectTimeoutMs?: number;
  now?: () => Date;
}

type Outcome =
  | { kind: "wrote"; bytes: number }
  | { kind: "failed"; reported: JobFailure; event: LogEvent; unexpected: boolean };

/**
 * The order of operations in SPEC §4.1, and the only entry point the shell needs.
 *
 * Steps 1-4 are pure and cannot touch the network, so a job that will be refused is refused before
 * it can queue behind a working printer. Steps 5-8 run under one deadline covering queue wait,
 * connect and write together.
 */
export class PrintService {
  private readonly gate: PrinterGate;
  private readonly transport: PrinterTransport;
  private readonly log: LogSink;
  private readonly suspicion: LocalNetworkSuspicion | null;
  private readonly jobDeadlineMs: number;
  private readonly connectTimeoutMs: number;
  private readonly now: () => Date;

  constructor(options: PrintServiceOptions) {
    this.gate = options.gate ?? new PrinterGate();
    this.transport = options.transport ?? new SocketPrinterTransport();
    this.log = options.log;
    this.suspicion = options.suspicion ?? null;
    this.jobDeadlineMs = options.jobDeadlineMs ?? JOB_DEADLINE_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Handle one call to `GoopterPOS.print`. `origin` is the calling frame's origin as the browser
   * reported it; the page never supplies it.
   *
   * @throws MalformedCall and only that. Everything else resolves: a throw means the page has a
   *   bug, `successful: false` means someone in the store has something to check.
   */
  async print(body: unknown, origin: string): Promise<PrintResponse> {
    let envelope: PrintEnvelope;
    try {
      envelope = readEnvelope(body);
    } catch (error) {
      if (error instanceof MalformedCall) {
        await this.record({ event: "rejected", origin, outcome: "malformed" });
        throw error;
      }
      const failure = error as JobFailure;
      // The refused address is the point of a rejection entry: the log exists to identify a wrong
      // address in Odoo.
      await this.record({ event: "rejected", origin, target: failure.target, outcome: failure.outcomeKey });
      return failureResponse(failure);
    }

    const { destination, data } = envelope;
    const target = destination.toString();
    await this.record({ event: "bridge_call", origin, target, bytes: data.length, outcome: "accepted" });

    // The clock starts here, before admission: a job that waited eleven seconds behind another
    // does not then get a fresh twelve to connect.
    const started = performance.now();
    const phase = new PhaseTracker();
    await this.record({ event: "queued", origin, target, outcome: "waiting" });

    // Only the job is inside this try, so a job that printed can never be reported as failed.
    let outcome: Outcome;
    try {
      const bytes = await withDeadline(this.jobDeadlineMs, () => phase.expiry(target), (signal) =>
        this.gate.run(destination, signal, () => {
          phase.markAttempted();
          return this.transport.send(data, destination, this.connectTimeoutMs, signal, () =>
            phase.markConnected(this.now()),
          );
        }),
      );
      outcome = { kind: "wrote", bytes };
    } catch (error) {
      if (error instanceof JobFailure) {
        outcome = { kind: "failed", reported: this.classify(error, destination.host), event: error.isTimeout ? "timeout" : "failed", unexpected: false };
      } else {
        // Nothing below should throw anything else. If it does, the page still gets an answer,
        // named by how far the job got, and the stack goes to stderr for whoever debugs it.
        console.error("Unexpected print failure", error);
        outcome = { kind: "failed", reported: this.classify(phase.expiry(target), destination.host), event: "failed", unexpected: true };
      }
    }

    // Written once the job has settled, stamped with the moment the socket opened, so a slow
    // printer and a refused one look different in the log.
    if (phase.connectedAt !== null) {
      await this.record({ timestamp: phase.connectedAt, event: "connect", origin, target, outcome: "open" });
    }
    const durationMs = Math.round(performance.now() - started);
    if (outcome.kind === "wrote") {
      this.suspicion?.recordSuccess();
      await this.record({ event: "wrote", origin, target, bytes: outcome.bytes, durationMs, outcome: "ok" });
      return successResponse(outcome.bytes);
    }
    await this.record({
      event: outcome.event, origin, target, durationMs,
      outcome: outcome.unexpected ? "internal_error" : outcome.reported.outcomeKey,
    });
    return failureResponse(outcome.reported);
  }

  /**
   * Fold the §8.2 heuristic into the failure being reported. Only a dialling failure counts: a
   * job that expired in the queue is evidence about the queue, not about a permission.
   */
  private classify(failure: JobFailure, host: string): JobFailure {
    if (this.suspicion === null) return failure;
    if (failure.kind === "unreachable") {
      this.suspicion.recordFailure(host);
      return this.suspicion.isSuspected ? JobFailure.unreachableMaybePermission(failure.target!) : failure;
    }
    if (failure.kind === "connectionRefused") {
      // The printer answered, so local network access demonstrably works.
      this.suspicion.recordSuccess();
    }
    return failure;
  }

  private record(fields: Omit<LogEntry, "timestamp"> & { timestamp?: Date }): Promise<void> {
    const entry: LogEntry = { timestamp: fields.timestamp ?? this.now(), event: fields.event, origin: fields.origin, outcome: fields.outcome };
    if (fields.target !== undefined) entry.target = fields.target;
    if (fields.bytes !== undefined) entry.bytes = fields.bytes;
    if (fields.durationMs !== undefined) entry.durationMs = fields.durationMs;
    return safely(this.log, entry);
  }
}

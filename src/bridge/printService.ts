import { CONNECT_TIMEOUT_MS, JOB_DEADLINE_MS, PRINTER_LIST_TIMEOUT_MS } from "./constants.js";
import { PhaseTracker, withDeadline } from "./deadline.js";
import { failureResponse, readEnvelope, successResponse, type PrintEnvelope, type PrintResponse } from "./envelope.js";
import { JobFailure, MalformedCall } from "./jobFailure.js";
import type { LocalNetworkSuspicion } from "./localNetworkSuspicion.js";
import { safely, type LogEntry, type LogEvent, type LogSink } from "./logEntry.js";
import { Destination } from "./destination.js";
import { InstalledPrinter, resolveInstalledPrinter, type PrinterDirectory } from "./installedPrinter.js";
import { PrinterGate } from "./printerGate.js";
import { ProcessSpoolerTransport, spoolCommand, type SpoolerTransport } from "./spoolerTransport.js";
import { SocketPrinterTransport, type PrinterTransport } from "./transport.js";

export interface PrintServiceOptions {
  gate?: PrinterGate;
  transport?: PrinterTransport;
  /** For printers installed on the till. Desktop only. */
  spooler?: SpoolerTransport;
  /** The printers installed on the till. Without one, every name is refused. */
  directory?: PrinterDirectory;
  log: LogSink;
  /** The §8.2 heuristic. Provided on macOS only; null elsewhere. */
  suspicion?: LocalNetworkSuspicion | null;
  jobDeadlineMs?: number;
  connectTimeoutMs?: number;
  printerListTimeoutMs?: number;
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
  private readonly spooler: SpoolerTransport;
  private readonly directory: PrinterDirectory;
  private readonly log: LogSink;
  private readonly suspicion: LocalNetworkSuspicion | null;
  private readonly jobDeadlineMs: number;
  private readonly connectTimeoutMs: number;
  private readonly printerListTimeoutMs: number;
  private readonly now: () => Date;

  constructor(options: PrintServiceOptions) {
    this.gate = options.gate ?? new PrinterGate();
    this.transport = options.transport ?? new SocketPrinterTransport();
    this.spooler = options.spooler ?? new ProcessSpoolerTransport((name) => spoolCommand(process.platform, name, "rawprint.exe"));
    this.directory = options.directory ?? { list: async () => [] };
    this.log = options.log;
    this.suspicion = options.suspicion ?? null;
    this.jobDeadlineMs = options.jobDeadlineMs ?? JOB_DEADLINE_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.printerListTimeoutMs = options.printerListTimeoutMs ?? PRINTER_LIST_TIMEOUT_MS;
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

    const { data } = envelope;
    let printer: Destination | InstalledPrinter;
    if (envelope.destination !== undefined) {
      printer = envelope.destination;
    } else {
      try {
        printer = resolveInstalledPrinter(envelope.printerName, await this.installed());
      } catch (error) {
        const failure = error as JobFailure;
        await this.record({ event: "rejected", origin, target: failure.target, outcome: failure.outcomeKey });
        return failureResponse(failure);
      }
    }
    const target = printer.toString();
    await this.record({ event: "bridge_call", origin, target, bytes: data.length, outcome: "accepted" });

    // The clock starts here, before admission: a job that waited eleven seconds behind another
    // does not then get a fresh twelve to connect.
    const started = performance.now();
    const phase = new PhaseTracker();
    const expiry = () => (printer instanceof InstalledPrinter ? phase.spoolerExpiry(printer) : phase.expiry(target));
    await this.record({ event: "queued", origin, target, outcome: "waiting" });

    // Only the job is inside this try, so a job that printed can never be reported as failed.
    let outcome: Outcome;
    try {
      const bytes = await withDeadline(this.jobDeadlineMs, expiry, (signal) =>
        this.gate.run(printer, signal, () => {
          phase.markAttempted();
          if (printer instanceof InstalledPrinter) return this.spooler.send(data, printer, signal);
          return this.transport.send(data, printer, this.connectTimeoutMs, signal, () =>
            phase.markConnected(this.now()),
          );
        }),
      );
      outcome = { kind: "wrote", bytes };
    } catch (error) {
      if (error instanceof JobFailure) {
        outcome = { kind: "failed", reported: this.classify(error, printer), event: error.isTimeout ? "timeout" : "failed", unexpected: false };
      } else {
        // Nothing below should throw anything else. If it does, the page still gets an answer,
        // named by how far the job got, and the stack goes to stderr for whoever debugs it.
        console.error("Unexpected print failure", error);
        outcome = { kind: "failed", reported: this.classify(expiry(), printer), event: "failed", unexpected: true };
      }
    }

    // Written once the job has settled, stamped with the moment the socket opened, so a slow
    // printer and a refused one look different in the log.
    if (phase.connectedAt !== null) {
      await this.record({ timestamp: phase.connectedAt, event: "connect", origin, target, outcome: "open" });
    }
    const durationMs = Math.round(performance.now() - started);
    if (outcome.kind === "wrote") {
      // A USB printer says nothing about whether the store LAN is reachable.
      if (printer instanceof Destination) this.suspicion?.recordSuccess();
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
  private classify(failure: JobFailure, printer: Destination | InstalledPrinter): JobFailure {
    if (this.suspicion === null || !(printer instanceof Destination)) return failure;
    if (failure.kind === "unreachable") {
      this.suspicion.recordFailure(printer.host);
      return this.suspicion.isSuspected ? JobFailure.unreachableMaybePermission(failure.target!) : failure;
    }
    if (failure.kind === "connectionRefused") {
      // The printer answered, so local network access demonstrably works.
      this.suspicion.recordSuccess();
    }
    return failure;
  }

  /** The OS's printer names. A list that cannot be read is treated as empty. */
  private async installed(): Promise<readonly string[]> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<readonly string[]>((resolve) => {
      timer = setTimeout(() => resolve([]), this.printerListTimeoutMs);
    });
    try {
      return await Promise.race([this.directory.list(), timeout]);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private record(fields: Omit<LogEntry, "timestamp"> & { timestamp?: Date }): Promise<void> {
    const entry: LogEntry = { timestamp: fields.timestamp ?? this.now(), event: fields.event, origin: fields.origin, outcome: fields.outcome };
    if (fields.target !== undefined) entry.target = fields.target;
    if (fields.bytes !== undefined) entry.bytes = fields.bytes;
    if (fields.durationMs !== undefined) entry.durationMs = fields.durationMs;
    return safely(this.log, entry);
  }
}

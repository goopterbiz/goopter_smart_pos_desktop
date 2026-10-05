import { SUPPORTED_PROTOCOL_VERSIONS } from "./constants.js";

/**
 * The call itself was not something this bridge can read, such as a non-object envelope.
 *
 * Distinct from `JobFailure` because it rejects the page's Promise: it means the page has a bug,
 * while every `JobFailure` resolves with `successful: false` because something in the store needs
 * attention.
 */
export class MalformedCall extends Error {
  constructor() {
    super("Malformed print call: expected a protocol 2 print envelope.");
    this.name = "MalformedCall";
  }
}

export type JobFailureKind =
  | "unsupportedVersion"
  | "missingHost"
  | "hostNotLocal"
  | "portNotAllowed"
  | "noData"
  | "queueTimedOut"
  | "connectionRefused"
  | "unreachable"
  | "unreachableMaybePermission"
  | "writeStalled"
  | "ambiguousPrinter"
  | "missingPrinterName"
  | "printerNotInstalled"
  | "spoolerRefused"
  | "spoolerTimedOut";

/**
 * Everything that can go wrong with a job the bridge understood (SPEC §5).
 *
 * `message` is shown verbatim to the cashier and names what to check. The iOS-only
 * `backgroundExpired` and the Android-only `unreachableNoPermission` have no trigger on desktop and
 * are not ported.
 */
export class JobFailure extends Error {
  private constructor(
    readonly kind: JobFailureKind,
    message: string,
    /** Stable key for the log's `outcome` column. Never shown to an operator. */
    readonly outcomeKey: string,
    /** The address this failure is about, so a log entry names what was refused. */
    readonly target?: string,
  ) {
    super(message);
    this.name = "JobFailure";
  }

  /** `sent` is the page's version as written, or null when it sent no number. */
  static unsupportedVersion(sent: string | null): JobFailure {
    const versions = SUPPORTED_PROTOCOL_VERSIONS.join(", ");
    return new JobFailure(
      "unsupportedVersion",
      `This app speaks print protocol ${versions}; the page sent ${sent ?? "none"}. Update the app.`,
      "unsupported_version",
    );
  }

  static missingHost(): JobFailure {
    return new JobFailure("missingHost", "No printer address was supplied.", "missing_host");
  }

  static hostNotLocal(host: string): JobFailure {
    return new JobFailure(
      "hostNotLocal",
      `${host} is not a local network address. Check the printer's IP in Odoo.`,
      "host_not_local",
      host,
    );
  }

  /**
   * `port` is the page's value as written, or null when none was sent. A missing port is its own
   * outcome: "Port 0 is not a printing port" would send an operator looking for a value Odoo never
   * wrote.
   */
  static portNotAllowed(host: string, port: string | null): JobFailure {
    if (port === null) {
      return new JobFailure(
        "portNotAllowed",
        "No printer port was supplied. Check the printer's port in Odoo.",
        "missing_port",
        host,
      );
    }
    return new JobFailure(
      "portNotAllowed",
      `Port ${port} is not a printing port. Check the printer's port in Odoo.`,
      "port_not_allowed",
      `${host}:${port}`,
    );
  }

  static noData(): JobFailure {
    return new JobFailure("noData", "The print job contained no data.", "no_data");
  }

  /** The deadline expired while still queued. A busy printer, not an absent one. */
  static queueTimedOut(target: string): JobFailure {
    return new JobFailure(
      "queueTimedOut",
      `The printer at ${target} is still busy with earlier jobs, so this one was not sent. Try again.`,
      "queue_timed_out",
      target,
    );
  }

  static connectionRefused(target: string): JobFailure {
    return new JobFailure(
      "connectionRefused",
      `The printer at ${target} refused the connection. It may be busy printing from another till.`,
      "connection_refused",
      target,
    );
  }

  static unreachable(target: string): JobFailure {
    return new JobFailure(
      "unreachable",
      `Could not reach the printer at ${target}. Check it is powered on and on the store network.`,
      "unreachable",
      target,
    );
  }

  /**
   * `unreachable`, plus the §8.2 heuristic suggesting the macOS Local Network permission. Only
   * produced on macOS; Windows and Linux have no such permission.
   */
  static unreachableMaybePermission(target: string): JobFailure {
    return new JobFailure(
      "unreachableMaybePermission",
      `Could not reach the printer at ${target}. Local network access may be turned off for Goopter Smart POS — ` +
        "check System Settings > Privacy & Security > Local Network.",
      "unreachable_maybe_permission",
      target,
    );
  }

  static writeStalled(target: string): JobFailure {
    return new JobFailure(
      "writeStalled",
      `The printer at ${target} accepted the job but stopped responding.`,
      "write_stalled",
      target,
    );
  }

  /** Decided without touching the network (§4.1 steps 2-4). */
  get isRejection(): boolean {
    return ["unsupportedVersion", "missingHost", "hostNotLocal", "portNotAllowed", "noData", "ambiguousPrinter",
      "missingPrinterName", "printerNotInstalled"].includes(this.kind);
  }

  /** Logged as `timeout` rather than `failed`. */
  get isTimeout(): boolean {
    return ["unreachable", "unreachableMaybePermission", "writeStalled", "queueTimedOut", "spoolerTimedOut"].includes(this.kind);
  }

  // Printers installed on the till (USB_PRINTING_SPEC). Desktop only.

  static ambiguousPrinter(): JobFailure {
    return new JobFailure(
      "ambiguousPrinter",
      "The printer setting has both an address and a name. Check the printer in Odoo.",
      "ambiguous_printer",
    );
  }

  static missingPrinterName(): JobFailure {
    return new JobFailure(
      "missingPrinterName",
      "No printer name was supplied. Check the printer name in Odoo.",
      "missing_printer_name",
    );
  }

  static printerNotInstalled(name: string): JobFailure {
    return new JobFailure(
      "printerNotInstalled",
      `No printer named "${name}" is installed on this computer. Check the printer name in Odoo.`,
      "printer_not_installed",
      name,
    );
  }

  /** The spooler exited with an error, or could not be started. */
  static spoolerRefused(name: string): JobFailure {
    return new JobFailure(
      "spoolerRefused",
      `This computer's print system refused the job for "${name}". Check the printer in system settings.`,
      "spooler_refused",
      name,
    );
  }

  /** The deadline expired after the spooler was started. */
  static spoolerTimedOut(name: string): JobFailure {
    return new JobFailure(
      "spoolerTimedOut",
      `This computer's print system did not take the job for "${name}" in time. Check the printer in system settings.`,
      "spooler_timed_out",
      name,
    );
  }
}

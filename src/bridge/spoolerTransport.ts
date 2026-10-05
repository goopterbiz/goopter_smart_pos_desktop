import { spawn } from "node:child_process";
import type { InstalledPrinter } from "./installedPrinter.js";
import { JobFailure } from "./jobFailure.js";

export interface SpoolerTransport {
  /**
   * Hand `data` to the OS print queue for `printer` and return the byte count.
   *
   * Rejects with a `JobFailure`, or with `signal.reason` when aborted so the deadline names the
   * failure.
   */
  send(data: Uint8Array, printer: InstalledPrinter, signal: AbortSignal): Promise<number>;
}

export interface SpoolCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * The program that takes raw bytes on stdin for `printerName` (USB_PRINTING_SPEC "Delivery").
 *
 * CUPS `lp` on Linux and macOS. On Windows, `helperPath` is the bundled `rawprint.exe`, which
 * writes through the spooler with the RAW datatype.
 */
export function spoolCommand(platform: NodeJS.Platform, printerName: string, helperPath: string): SpoolCommand {
  if (platform === "win32") return { file: helperPath, args: [printerName] };
  return { file: "lp", args: ["-d", printerName, "-o", "raw"] };
}

/**
 * One spooler process per job, started without a shell so a printer name is only ever an argument.
 *
 * "Written" means the spooler accepted the job and exited 0. It is not a claim that paper moved,
 * the same definition the socket transport uses.
 */
export class ProcessSpoolerTransport implements SpoolerTransport {
  constructor(private readonly command: (printerName: string) => SpoolCommand) {}

  send(data: Uint8Array, printer: InstalledPrinter, signal: AbortSignal): Promise<number> {
    // A cancelled job never reaches the print queue.
    if (signal.aborted) return Promise.reject(signal.reason);
    const { file, args } = this.command(printer.name);

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const child = spawn(file, [...args], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });

      const finish = (outcome: { error: unknown } | { bytes: number }) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.bytes);
      };

      // Settled from `close`, not here: a spooler that exited 0 just as the deadline passed has the
      // job, and reporting it failed would make the cashier print it twice. SIGKILL, because a
      // spooler that ignores SIGTERM would otherwise hold the job past its deadline.
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        child.kill("SIGKILL");
      };
      signal.addEventListener("abort", onAbort, { once: true });

      // Not started (no `lp`, no helper) or exited with an error: the print system said no.
      child.on("error", () => finish({ error: aborted ? signal.reason : JobFailure.spoolerRefused(printer.name) }));
      child.on("close", (code) => {
        if (code === 0) finish({ bytes: data.length });
        else finish({ error: aborted ? signal.reason : JobFailure.spoolerRefused(printer.name) });
      });
      // A spooler that exits before reading everything breaks the pipe. Its exit code decides.
      child.stdin.on("error", () => undefined);
      child.stdin.end(data);
    });
  }
}

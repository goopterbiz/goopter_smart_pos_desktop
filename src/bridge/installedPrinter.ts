import { JobFailure } from "./jobFailure.js";

/** The names of the printers the OS has installed, as its print system knows them. */
export interface PrinterDirectory {
  list(): Promise<readonly string[]>;
}

/**
 * A printer installed on the till, reached through the OS print queue (USB_PRINTING_SPEC). Only
 * `resolveInstalledPrinter` makes one, so holding one is proof the name was checked.
 */
export class InstalledPrinter {
  private constructor(readonly name: string) {}

  /** Never equal to a `Destination` key, so an installed printer and a network one never share a lock. */
  get gateKey(): string {
    return `name:${this.name}`;
  }

  /** What the log records as the target. */
  toString(): string {
    return this.name;
  }

  /** @internal */
  static make(name: string): InstalledPrinter {
    return new InstalledPrinter(name);
  }
}

/**
 * Accept `name` only if it is one of `installed`, exactly. Matching the OS's own list is also what
 * keeps a name from being read as a command-line option by the spooler. There is no default
 * printer: a name is required.
 *
 * @throws JobFailure when the name is empty or no installed printer has it.
 */
export function resolveInstalledPrinter(name: string, installed: readonly string[]): InstalledPrinter {
  if (name === "") throw JobFailure.missingPrinterName();
  if (!installed.includes(name)) throw JobFailure.printerNotInstalled(name);
  return InstalledPrinter.make(name);
}

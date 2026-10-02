import type { PrintResponse } from "./envelope.js";
import { isAllowed } from "./hostPolicy.js";
import { MalformedCall } from "./jobFailure.js";
import { safely, type LogSink } from "./logEntry.js";
import type { PrintService } from "./printService.js";

/** What the preload turns into a resolved or rejected Promise. */
export type PrintReply = { response: PrintResponse } | { error: string };

export const NOT_PERMITTED = "This page is not permitted to print.";

/**
 * The main-process side of `GoopterPOS.print` (SPEC §3.3, §6.2): who is answered, and in what shape.
 *
 * The origin is never read from the message. It is what Chromium reports about the calling frame,
 * re-checked here even though the preload only exposes the bridge on allowlisted main frames, so
 * the rule holds even if exposure is ever wrong.
 */
export class PrintBridgeHandler {
  private readonly service: PrintService;
  private readonly log: LogSink;
  private readonly debugOrigin: string | null;
  private readonly now: () => Date;

  constructor(options: { service: PrintService; log: LogSink; debugOrigin: string | null; now?: () => Date }) {
    this.service = options.service;
    this.log = options.log;
    this.debugOrigin = options.debugOrigin;
    this.now = options.now ?? (() => new Date());
  }

  async handle(envelope: unknown, sourceOrigin: string, isMainFrame: boolean): Promise<PrintReply> {
    if (!isMainFrame || !isAllowed(sourceOrigin, this.debugOrigin)) {
      // Logged, or the page asks, nothing prints, and the log stays empty as if it never asked.
      await safely(this.log, { timestamp: this.now(), event: "rejected", origin: sourceOrigin, outcome: "origin_not_permitted" });
      return { error: NOT_PERMITTED };
    }
    try {
      return { response: await this.service.print(envelope, sourceOrigin) };
    } catch (error) {
      if (error instanceof MalformedCall) return { error: error.message };
      throw error;
    }
  }
}

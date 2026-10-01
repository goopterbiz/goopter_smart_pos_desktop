/**
 * One line in the diagnostic log (SPEC §11). Spelled as the iOS and Android logs spell them.
 *
 * Note what is absent: the payload. A receipt carries customer names and order contents.
 */
export interface LogEntry {
  timestamp: Date;
  event: LogEvent;
  origin: string;
  target?: string;
  bytes?: number;
  durationMs?: number;
  outcome: string;
}

export type LogEvent =
  /** Written once per launch, so an empty log means a broken log rather than no prints. */
  | "launched"
  | "bridge_call"
  | "rejected"
  | "queued"
  | "connect"
  | "wrote"
  | "timeout"
  | "failed"
  /** An error or `console.error` from the hosted page. */
  | "page_error";

export type LogSink = (entry: LogEntry) => void | Promise<void>;

/** Write `entry`, and never let the log change what happens next. */
export async function safely(sink: LogSink, entry: LogEntry): Promise<void> {
  try {
    await sink(entry);
  } catch {
    // An entry that cannot be written costs a diagnosis, never a receipt.
  }
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { LOG_RETENTION_MS, LOG_SIZE_CAP } from "./constants.js";
import type { LogEntry, LogEvent } from "./logEntry.js";

export const LOG_FILE_NAME = "print-jobs.jsonl";

/** Prune every N appends rather than on each one: rewriting the file is O(entries). */
const PRUNE_INTERVAL = 32;
/** Also prune on a clock, so a quiet till that prints twice a day still honours retention. */
const PRUNE_AFTER_MS = 60 * 60 * 1000;

/**
 * A rotating JSON-lines log on disk (SPEC §11).
 *
 * On disk because a cashier will have restarted the app before anyone is asked to look. One object
 * per line, so a crash mid-write costs the last line, not the file. Every operation runs on one
 * queue, so appends never interleave with a prune.
 *
 * Nothing here throws to the caller: a log that cannot be written costs a diagnosis, never a print.
 */
export class JobLog {
  private readonly file: string;
  private readonly now: () => Date;
  private readonly retentionMs: number;
  private readonly sizeCap: number;
  private entries: LogEntry[] = [];
  /** False until the file has been read. A read that fails is tried again on the next use. */
  private loaded = false;
  private appendsSincePrune = 0;
  private lastPrune = 0;
  private queue: Promise<unknown> = Promise.resolve();

  /** Appends one line to the file. Replaceable so tests can make the open fail. */
  appendLine: (file: string, line: string) => Promise<void> = (file, line) => fs.appendFile(file, line, { flag: "a" });

  /** Construction does no I/O: a full log is read on first use, never at launch. */
  constructor(
    private readonly directory: string,
    options: { now?: () => Date; retentionMs?: number; sizeCap?: number } = {},
  ) {
    this.file = path.join(directory, LOG_FILE_NAME);
    this.now = options.now ?? (() => new Date());
    this.retentionMs = options.retentionMs ?? LOG_RETENTION_MS;
    this.sizeCap = options.sizeCap ?? LOG_SIZE_CAP;
  }

  append(entry: LogEntry): Promise<void> {
    return this.enqueue(async () => {
      const line = encode(entry);
      if (!(await this.loadIfNeeded())) {
        // Nothing can be pruned while the file cannot be read, so the cap is held by not growing.
        if ((await this.fileSize()) + Buffer.byteLength(line) <= this.sizeCap) {
          await this.appendLine(this.file, line).catch(() => undefined);
        }
        return;
      }
      this.entries.push(entry);
      this.appendsSincePrune += 1;
      if (this.appendsSincePrune >= PRUNE_INTERVAL || this.now().getTime() - this.lastPrune > PRUNE_AFTER_MS) {
        await this.prune();
        return;
      }
      try {
        await this.appendLine(this.file, line);
      } catch {
        // Dropped. Rewriting the file here would replace the history with what is in memory.
        return;
      }
      if ((await this.fileSize()) > this.sizeCap) await this.prune();
    }, undefined);
  }

  /** Newest first, the order anyone reading a log wants. */
  recent(limit?: number): Promise<LogEntry[]> {
    return this.enqueue(async () => {
      if (!(await this.loadIfNeeded())) return [];
      const ordered = [...this.entries].reverse();
      return limit === undefined ? ordered : ordered.slice(0, limit);
    }, []);
  }

  /** Run `work` after everything queued before it. An unexpected error yields `fallback`. */
  private enqueue<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    const run = this.queue.then(work).catch(() => fallback);
    this.queue = run;
    return run;
  }

  /** Read the file on first use. False while it exists but cannot be read. */
  private async loadIfNeeded(): Promise<boolean> {
    if (this.loaded) return true;
    await fs.mkdir(this.directory, { recursive: true }).catch(() => undefined);
    let text = "";
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (error) {
      // A log that cannot be read right now is not an empty log: pruning it would replace seven
      // days of history with nothing. Left unloaded, so the next use tries again.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    this.loaded = true;
    this.entries = text.split("\n").map(decode).filter((e): e is LogEntry => e !== null);
    if (text === "") this.lastPrune = this.now().getTime();
    else await this.prune();
    return true;
  }

  /** Drop what is too old, then what does not fit, oldest first, and rewrite the file atomically. */
  private async prune(): Promise<void> {
    const cutoff = this.now().getTime() - this.retentionMs;
    const kept = this.entries
      .filter((e) => e.timestamp.getTime() >= cutoff)
      .map((entry) => ({ entry, line: encode(entry) }));
    let total = kept.reduce((sum, k) => sum + Buffer.byteLength(k.line), 0);
    while (total > this.sizeCap && kept.length > 0) total -= Buffer.byteLength(kept.shift()!.line);
    this.entries = kept.map((k) => k.entry);
    this.appendsSincePrune = 0;
    this.lastPrune = this.now().getTime();
    const temp = `${this.file}.tmp`;
    try {
      await fs.writeFile(temp, kept.map((k) => k.line).join(""));
      await fs.rename(temp, this.file);
    } catch {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async fileSize(): Promise<number> {
    try {
      return (await fs.stat(this.file)).size;
    } catch {
      return 0;
    }
  }
}

const EVENTS: ReadonlySet<string> = new Set<LogEvent>([
  "launched", "bridge_call", "rejected", "queued", "connect", "wrote", "timeout", "failed", "page_error",
]);

function encode(entry: LogEntry): string {
  const out: Record<string, unknown> = {
    timestamp: entry.timestamp.toISOString(),
    event: entry.event,
    origin: entry.origin,
  };
  if (entry.target !== undefined) out.target = entry.target;
  if (entry.bytes !== undefined) out.bytes = entry.bytes;
  if (entry.durationMs !== undefined) out.durationMs = entry.durationMs;
  out.outcome = entry.outcome;
  return JSON.stringify(out) + "\n";
}

/** A truncated or unreadable line decodes to null and is dropped. */
function decode(line: string): LogEntry | null {
  if (line.trim() === "") return null;
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const timestamp = typeof raw.timestamp === "string" ? new Date(raw.timestamp) : null;
    if (timestamp === null || Number.isNaN(timestamp.getTime())) return null;
    if (typeof raw.event !== "string" || !EVENTS.has(raw.event)) return null;
    if (typeof raw.origin !== "string" || typeof raw.outcome !== "string") return null;
    const entry: LogEntry = { timestamp, event: raw.event as LogEvent, origin: raw.origin, outcome: raw.outcome };
    if (typeof raw.target === "string") entry.target = raw.target;
    if (typeof raw.bytes === "number") entry.bytes = raw.bytes;
    if (typeof raw.durationMs === "number") entry.durationMs = raw.durationMs;
    return entry;
  } catch {
    return null;
  }
}

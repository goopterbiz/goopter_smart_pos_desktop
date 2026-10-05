import { MAX_IN_FLIGHT } from "./constants.js";
import type { Destination } from "./destination.js";
import type { InstalledPrinter } from "./installedPrinter.js";

/** A FIFO counting semaphore whose waiters leave the queue when their signal aborts. */
class Semaphore {
  private readonly waiters: (() => void)[] = [];

  constructor(private permits: number) {}

  acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.permits > 0 && this.waiters.length === 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const at = this.waiters.indexOf(grant);
        if (at !== -1) this.waiters.splice(at, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits += 1;
  }
}

/**
 * Admission control for print jobs (SPEC §9).
 *
 * One job at a time per printer, because a printer accepts one connection at a time and a second
 * connect hangs rather than failing. A global cap, so a store whose network has gone cannot
 * accumulate unbounded half-open sockets.
 *
 * The printer's lock is taken before a global slot, as on Android: a job waiting for its printer
 * holds no slot, so retries piling up behind a stuck kitchen printer cannot stop the receipt
 * printer. Both limits are FIFO and released on every exit.
 */
export class PrinterGate {
  private readonly slots: Semaphore;
  /** One lock per printer, made on first use and never discarded. A store has a handful. */
  private readonly locks = new Map<string, Semaphore>();

  constructor(maxInFlight: number = MAX_IN_FLIGHT) {
    this.slots = new Semaphore(maxInFlight);
  }

  async run<T>(printer: Destination | InstalledPrinter, signal: AbortSignal, body: () => Promise<T>): Promise<T> {
    const lock = this.lockFor(printer.gateKey);
    await lock.acquire(signal);
    try {
      await this.slots.acquire(signal);
      try {
        // A permit handed over as the deadline expired must not dial.
        signal.throwIfAborted();
        return await body();
      } finally {
        this.slots.release();
      }
    } finally {
      lock.release();
    }
  }

  private lockFor(key: string): Semaphore {
    let lock = this.locks.get(key);
    if (lock === undefined) {
      lock = new Semaphore(1);
      this.locks.set(key, lock);
    }
    return lock;
  }
}

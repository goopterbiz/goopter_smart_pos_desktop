import { JobFailure } from "./jobFailure.js";

/**
 * Run `body`, giving up after `ms` with the failure `expiry` names rather than a generic timeout
 * (SPEC §9).
 *
 * On expiry the body's signal is aborted and this waits for the body to unwind, so the gate has
 * already handed the printer back before the failure is reported. `expiry` is called after that,
 * so whatever it reads is settled. A body that finished despite the abort reports its result: a
 * job that printed must never be reported as failed, because the cashier answers that by printing
 * it again.
 */
export async function withDeadline<T>(
  ms: number,
  expiry: () => Error,
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new Error("deadline"));
  }, ms);
  try {
    return await body(controller.signal);
  } catch (error) {
    if (expired) throw expiry();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How far a job got, so an expired deadline can say which of three things went wrong.
 *
 * Never dialled: the queue is backed up. Dialled but never opened: go to the printer. Opened, then
 * stalled: the printer is there and the job is stuck.
 */
export class PhaseTracker {
  private attempted = false;
  /** When the socket opened, or null if it never did. Wall clock, because it is logged. */
  connectedAt: Date | null = null;

  markAttempted(): void {
    this.attempted = true;
  }

  markConnected(at: Date): void {
    this.connectedAt = at;
  }

  expiry(target: string): JobFailure {
    if (this.connectedAt !== null) return JobFailure.writeStalled(target);
    if (this.attempted) return JobFailure.unreachable(target);
    return JobFailure.queueTimedOut(target);
  }
}

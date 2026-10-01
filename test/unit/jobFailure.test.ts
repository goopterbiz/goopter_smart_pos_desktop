import { describe, expect, it } from "vitest";
import { JobFailure } from "../../src/bridge/jobFailure.js";

/** SPEC §5. The message is shown verbatim to the cashier, so it is pinned word for word. */
describe("JobFailure", () => {
  const t = "10.0.0.5:9100";

  it("carries the §5 message for every case", () => {
    const cases: [JobFailure, string][] = [
      [JobFailure.unsupportedVersion("3"), "This app speaks print protocol 2; the page sent 3. Update the app."],
      [JobFailure.missingHost(), "No printer address was supplied."],
      [JobFailure.hostNotLocal("8.8.8.8"), "8.8.8.8 is not a local network address. Check the printer's IP in Odoo."],
      [JobFailure.portNotAllowed("10.0.0.5", "22"), "Port 22 is not a printing port. Check the printer's port in Odoo."],
      [JobFailure.portNotAllowed("10.0.0.5", null), "No printer port was supplied. Check the printer's port in Odoo."],
      [JobFailure.noData(), "The print job contained no data."],
      [JobFailure.queueTimedOut(t), `The printer at ${t} is still busy with earlier jobs, so this one was not sent. Try again.`],
      [JobFailure.connectionRefused(t), `The printer at ${t} refused the connection. It may be busy printing from another till.`],
      [JobFailure.unreachable(t), `Could not reach the printer at ${t}. Check it is powered on and on the store network.`],
      [JobFailure.writeStalled(t), `The printer at ${t} accepted the job but stopped responding.`],
    ];
    for (const [failure, message] of cases) expect(failure.message).toBe(message);
  });

  it("the macOS permission hint names the Local Network setting", () => {
    expect(JobFailure.unreachableMaybePermission(t).message).toBe(
      `Could not reach the printer at ${t}. Local network access may be turned off for Goopter Smart POS — ` +
        "check System Settings > Privacy & Security > Local Network.",
    );
  });

  it("names the target each log entry records", () => {
    expect(JobFailure.hostNotLocal("8.8.8.8").target).toBe("8.8.8.8");
    expect(JobFailure.portNotAllowed("10.0.0.5", "22").target).toBe("10.0.0.5:22");
    expect(JobFailure.portNotAllowed("10.0.0.5", null).target).toBe("10.0.0.5");
    expect(JobFailure.unreachable(t).target).toBe(t);
    expect(JobFailure.noData().target).toBeUndefined();
  });

  it("separates rejections from timeouts", () => {
    expect(JobFailure.hostNotLocal("x").isRejection).toBe(true);
    expect(JobFailure.unreachable(t).isRejection).toBe(false);
    for (const failure of [JobFailure.unreachable(t), JobFailure.unreachableMaybePermission(t),
      JobFailure.writeStalled(t), JobFailure.queueTimedOut(t)]) {
      expect(failure.isTimeout).toBe(true);
    }
    expect(JobFailure.connectionRefused(t).isTimeout).toBe(false);
  });
});

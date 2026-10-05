/**
 * The tunable numbers from SPEC §9, identical to the iOS and Android apps. Collected here so the
 * whole budget is readable at once: every one of them is a trade against the 15 s the POS client
 * allows a print job.
 */

/** Envelope versions this build accepts. Advertised to the page as `protocolVersions`. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = Object.freeze([2]);

/**
 * Whole-job budget: queue wait, connect and write together. Three seconds under the client's
 * 15 s, so the cashier reads a message naming the printer instead of a generic client timeout.
 */
export const JOB_DEADLINE_MS = 12_000;

/** A printer on the same subnet answers in milliseconds; five seconds is a printer that is not there. */
export const CONNECT_TIMEOUT_MS = 5_000;

/**
 * How long the OS gets to list its printers before a named job is checked against an empty list.
 * Spent before the job deadline starts, so with it a job still answers inside the client's 15 s.
 */
export const PRINTER_LIST_TIMEOUT_MS = 2_000;

/** Concurrent jobs across all printers. */
export const MAX_IN_FLIGHT = 4;

/** 9100-9109 RAW/JetDirect including multi-port print servers, 515 LPR, 631 IPP (§8.1). */
export const ALLOWED_PORTS: ReadonlySet<number> = new Set([
  9100, 9101, 9102, 9103, 9104, 9105, 9106, 9107, 9108, 9109, 515, 631,
]);

/** Log retention and size cap (§11). */
export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LOG_SIZE_CAP = 5 * 1024 * 1024;

/**
 * Thresholds for guessing that macOS local network access was denied (§8.2). Both must be met,
 * and any success clears both.
 */
export const PERMISSION_SUSPICION_DISTINCT_HOSTS = 2;
export const PERMISSION_SUSPICION_FAILURES = 3;

/** The domain each store is a subdomain of. A person enters the label; this is the rest. */
export const TENANT_DOMAIN = "goopter.com";

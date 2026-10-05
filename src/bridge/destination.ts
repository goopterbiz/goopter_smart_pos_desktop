import { ALLOWED_PORTS } from "./constants.js";
import { JobFailure } from "./jobFailure.js";

/**
 * A validated printer socket address. Only `validateDestination` makes one outside tests, so
 * holding a `Destination` is proof the §8.1 checks have run.
 */
export class Destination {
  private constructor(
    readonly host: string,
    readonly port: number,
  ) {}

  toString(): string {
    return `${this.host}:${this.port}`;
  }

  /** The printer's lock in the gate. */
  get gateKey(): string {
    return this.toString();
  }

  /** @internal */
  static make(host: string, port: number): Destination {
    return new Destination(host, port);
  }
}

/**
 * Where a print job is allowed to go (SPEC §8.1).
 *
 * The bridge is a general-purpose TCP client callable from a web page. The origin check decides
 * who may ask; this decides where. Runs before a job may queue, so a misconfigured printer is
 * reported at once rather than after waiting behind a working one.
 *
 * `port` is the page's value as written, so `9100.5` is refused as sent rather than truncated.
 * The host is checked first, so a job wrong in both ways reports the address.
 *
 * @throws JobFailure when the destination is refused.
 */
export function validateDestination(host: string | null, port: string | null): Destination {
  // Trimmed, not refused: a stray space on an Odoo config field is invisible to whoever reads it.
  // Interior whitespace still fails the parse.
  const trimmed = (host ?? "").trim();
  if (trimmed === "") throw JobFailure.missingHost();
  const octets = dottedQuad(trimmed);
  if (octets === null || !isLocal(octets)) throw JobFailure.hostNotLocal(trimmed);
  const number = port === null ? NaN : Number.parseInt(port, 10);
  if (port === null || String(number) !== port || !ALLOWED_PORTS.has(number)) {
    throw JobFailure.portNotAllowed(trimmed, port);
  }
  return Destination.make(trimmed, number);
}

/**
 * A destination that skips §8.1, for the loopback tests: 127.0.0.1 is refused by design, because
 * nothing on a till is a printer. Never called by the app.
 */
export function uncheckedDestination(host: string, port: number): Destination {
  return Destination.make(host, port);
}

/**
 * Strict dotted-quad IPv4, or null. Hand-rolled on purpose: a leading zero is octal to some
 * resolvers, so `010.0.0.1` is refused rather than interpreted, and nothing here resolves a name.
 */
function dottedQuad(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * The four admitted ranges. Everything else is refused, which excludes loopback, multicast,
 * broadcast, 0.0.0.0 and every public address without a rule of its own.
 */
function isLocal([first, second]: number[]): boolean {
  if (first === 10) return true; // 10.0.0.0/8
  if (first === 172 && second !== undefined && second >= 16 && second <= 31) return true; // 172.16.0.0/12
  if (first === 192 && second === 168) return true; // 192.168.0.0/16
  if (first === 169 && second === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

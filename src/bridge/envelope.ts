import { SUPPORTED_PROTOCOL_VERSIONS } from "./constants.js";
import { Destination, validateDestination } from "./destination.js";
import { JobFailure, MalformedCall } from "./jobFailure.js";

/** A print job that has passed every check in §4.1 steps 1-4. */
export interface PrintEnvelope {
  readonly destination: Destination;
  readonly data: Uint8Array;
}

/**
 * The response handed back to the page (SPEC §3.3). Absent fields are omitted, not sent as null,
 * so the page sees a missing property.
 */
export type PrintResponse =
  | { successful: true; bytes: number }
  | { successful: false; message: string };

export const successResponse = (bytes: number): PrintResponse => ({ successful: true, bytes });
export const failureResponse = (failure: JobFailure): PrintResponse => ({ successful: false, message: failure.message });

/**
 * Decode and validate, in the order §4.1 mandates. `protocol_version` is checked before any other
 * key is read, which lets a caller probe the bridge with a version it knows will be refused.
 *
 * @throws MalformedCall when the argument is not an object.
 * @throws JobFailure when the envelope is refused.
 */
export function readEnvelope(body: unknown): PrintEnvelope {
  if (!isRecord(body)) throw new MalformedCall();

  // Step 2: version, before anything else. Compared as written, so 2.7 is not 2.
  const version = numberText(body.protocol_version);
  if (version === null || !SUPPORTED_PROTOCOL_VERSIONS.map(String).includes(version)) {
    throw JobFailure.unsupportedVersion(version);
  }

  // Step 3: destination.
  const printer = isRecord(body.printer) ? body.printer : undefined;
  const host = typeof printer?.host === "string" ? printer.host : null;
  const destination = validateDestination(host, numberText(printer?.port));

  // Step 4: payload. Strict base64: a string with stray characters is a page bug dressed as data,
  // and printing a partial decode would put garbage on paper.
  const encoded = body.data_base64;
  const data = typeof encoded === "string" ? decodeBase64Strict(encoded) : null;
  if (data === null || data.length === 0) throw JobFailure.noData();

  return { destination, data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A number's text as written, or null for anything that is not a finite number. */
function numberText(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

/**
 * RFC 4648 base64, refusing anything Buffer would silently skip: whitespace, characters outside
 * the alphabet, misplaced padding and a dangling sixth bit. Padding is optional, as it is for the
 * Android decoder.
 */
function decodeBase64Strict(encoded: string): Uint8Array | null {
  const match = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(encoded);
  if (match === null) return null;
  const body = match[1] ?? "";
  const padding = match[2] ?? "";
  if (body.length === 0) return null;
  const remainder = body.length % 4;
  if (remainder === 1) return null;
  if (padding.length > 0 && (body.length + padding.length) % 4 !== 0) return null;
  if (padding.length > 0 && padding.length !== (4 - remainder) % 4) return null;
  return new Uint8Array(Buffer.from(body, "base64"));
}

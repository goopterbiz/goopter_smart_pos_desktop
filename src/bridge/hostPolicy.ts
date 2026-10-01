import { TENANT_DOMAIN } from "./constants.js";

/**
 * Which pages the bridge may be given to, and the POS window may show (SPEC §6.2).
 *
 * HTTPS on the default port to the tenant domain or a subdomain of it, matched on a leading dot so
 * `evilgoopter.com` does not pass. An http page on a merchant's Wi-Fi is a page anyone on that
 * Wi-Fi can rewrite. The one exception is the debug origin, which is configured only in an
 * unpackaged build and matched exactly.
 */
export function isAllowed(url: string | null | undefined, debugOrigin: string | null = null): boolean {
  const parsed = parse(url);
  if (parsed === null) return false;
  if (debugOrigin !== null && parsed.origin === debugOrigin) return true;
  if (parsed.protocol !== "https:" || parsed.port !== "") return false;
  const host = parsed.hostname;
  return host === TENANT_DOMAIN || host.endsWith("." + TENANT_DOMAIN);
}

/** `scheme://host[:port]`, lowercased, for http(s) URLs; otherwise null. What the log records. */
export function originOf(url: string | null | undefined): string | null {
  return parse(url)?.origin ?? null;
}

/**
 * WHATWG URL parsing, which is what Chromium uses, so the host compared here is the host the
 * window loads. A trailing-dot host is refused rather than treated as its dotless twin.
 */
function parse(url: string | null | undefined): URL | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.hostname === "" || parsed.hostname.endsWith(".")) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed;
}

import { TENANT_DOMAIN } from "./constants.js";
import { isAllowed } from "./hostPolicy.js";

/** The longest a DNS label may be (RFC 1035). */
export const MAXIMUM_LABEL_LENGTH = 63;

/**
 * The store name a person types on the entry screen, reduced to one DNS label (SPEC §2.2).
 *
 * The only user-supplied text this app concatenates into a URL, so it is treated the way a printer
 * address is: normalise what a person plausibly typed, then refuse anything that is not exactly the
 * shape expected. Staff paste the whole address, so `https://JadeGarden.goopter.com/` has to work.
 * A single label cannot carry a path, a port, userinfo or a second host.
 */
export function normalizeSlug(raw: string, strippingDomain: string): string | null {
  // Lowercasing precedes the scheme strip, so an uppercase scheme is still recognised.
  let value = raw.trim().toLowerCase();
  for (const scheme of ["https://", "http://"]) {
    if (value.startsWith(scheme)) {
      value = value.slice(scheme.length);
      break;
    }
  }
  const slash = value.indexOf("/");
  if (slash !== -1) value = value.slice(0, slash);
  // A fully qualified name may end in a root dot.
  value = value.replace(/\.+$/, "");
  const suffix = "." + strippingDomain.toLowerCase();
  if (value.endsWith(suffix)) value = value.slice(0, -suffix.length);
  return isValidLabel(value) ? value : null;
}

/**
 * The page this app shows for a stored store, or null. A slug is used only if normalising it
 * returns it unchanged: stored is not the same as trusted.
 */
export function launchUrl(slug: string): string | null {
  if (normalizeSlug(slug, TENANT_DOMAIN) !== slug) return null;
  const url = `https://${slug}.${TENANT_DOMAIN}/odoo/point-of-sale?debug=0`;
  return isAllowed(url) ? url : null;
}

/**
 * One LDH label: ASCII letters, digits and interior hyphens. Punycode is refused too, so a
 * non-ASCII store name cannot get in under its `xn--` spelling.
 */
function isValidLabel(value: string): boolean {
  if (value.length === 0 || value.length > MAXIMUM_LABEL_LENGTH) return false;
  if (value.startsWith("-") || value.endsWith("-")) return false;
  if (value.startsWith("xn--")) return false;
  return /^[a-z0-9-]+$/.test(value);
}

import { isAllowed } from "./hostPolicy.js";

/** What the POS window does with a navigation it is asked to make. */
export type Navigation =
  /** Load it here. */
  | "load"
  /** Off-allowlist web page: the system browser, visibly not the POS and with no bridge. */
  | "openInBrowser"
  /** A phone number, email or text a person clicked: hand it to the system. */
  | "handToSystem"
  /** Nothing loaded yet and the start is off-allowlist: a configuration error, shown as one. */
  | "refuseStart"
  | "cancel";

const SYSTEM_SCHEMES = new Set(["tel", "mailto", "sms"]);
/** Inert and page-generated. A frame written by script starts at about:blank. */
const INERT_SCHEMES = new Set(["about", "blob"]);

/**
 * Where the POS window may go (SPEC §6.2). An allowlisted page that navigates elsewhere must not
 * keep the bridge, so navigation policy is part of the origin boundary.
 *
 * - Subframes are page content (a payment iframe, a captcha) and load in place. They get no bridge.
 * - Every scheme not named here is cancelled, or the POS page becomes a launcher for whatever else
 *   is installed, reachable by any script it loads.
 */
export function decideNavigation(n: {
  url: string;
  isMainFrame: boolean;
  /** A person clicked, as opposed to a script navigating on its own. */
  hasGesture: boolean;
  /** False until the first page commits: before then an off-allowlist page is a failed start. */
  hasLoadedPage: boolean;
  debugOrigin: string | null;
}): Navigation {
  const colon = n.url.indexOf(":");
  const scheme = colon === -1 ? "" : n.url.slice(0, colon).toLowerCase();
  const isWeb = scheme === "http" || scheme === "https";

  if (!n.isMainFrame) return isWeb || INERT_SCHEMES.has(scheme) ? "load" : "cancel";
  if (isAllowed(n.url, n.debugOrigin) || INERT_SCHEMES.has(scheme)) return "load";
  if (isWeb) return n.hasLoadedPage ? "openInBrowser" : "refuseStart";
  return SYSTEM_SCHEMES.has(scheme) && n.hasGesture ? "handToSystem" : "cancel";
}

/**
 * Which API the preload gives a frame: the print bridge, the app's own screens, or nothing.
 *
 * Decided in the main process from the URL Chromium reports for the frame, never from anything the
 * page says. Only main frames get either.
 */
export function frameRole(f: {
  url: string;
  isMainFrame: boolean;
  debugOrigin: string | null;
  /** `file://` URL of the directory holding the app's own screens, with a trailing slash. */
  shellUrlPrefix: string;
}): "pos" | "shell" | null {
  if (!f.isMainFrame) return null;
  if (isAllowed(f.url, f.debugOrigin)) return "pos";
  let normalized: string;
  try {
    normalized = new URL(f.url).href;
  } catch {
    return null;
  }
  return normalized.startsWith(f.shellUrlPrefix) ? "shell" : null;
}

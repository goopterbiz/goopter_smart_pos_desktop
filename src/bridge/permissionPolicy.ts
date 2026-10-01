import { isAllowed } from "./hostPolicy.js";

/**
 * Which permissions the POS page may have (C2).
 *
 * Notifications are refused everywhere: granting it makes Odoo subscribe to Web Push on startup
 * (`mail/static/src/webclient/web/webclient.js`), and Electron has no push service to subscribe to,
 * so the subscription fails and Odoo shows a sticky error toast on every launch. The kiosk and
 * pending-acceptance alerts arrive over the Odoo bus websocket and are unaffected.
 *
 * Every other permission (camera, clipboard, geolocation, and so on) is granted to the main frame
 * of an allowlisted origin, same as before, and refused everywhere else: a subframe such as a
 * payment iframe, or a page that is not the store.
 */
export function isPermissionGranted(p: {
  permission: string;
  url: string | null | undefined;
  isMainFrame: boolean;
  debugOrigin: string | null;
}): boolean {
  if (p.permission === "notifications") return false;
  return p.isMainFrame && isAllowed(p.url, p.debugOrigin);
}

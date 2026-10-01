import { describe, expect, it } from "vitest";
import { isPermissionGranted } from "../../src/bridge/permissionPolicy.js";

/** C2: who may have a permission. Same shape as HostPolicy and NavigationPolicy tests. */
describe("permissionPolicy", () => {
  const main = (permission: string, url = "https://x.goopter.com/odoo/point-of-sale", debugOrigin: string | null = null) =>
    isPermissionGranted({ permission, url, isMainFrame: true, debugOrigin });

  it("refuses notifications on an allowlisted main frame", () => {
    expect(main("notifications")).toBe(false);
  });

  it("grants every other permission to an allowlisted main frame", () => {
    expect(main("media")).toBe(true);
    expect(main("clipboard-sanitized-write")).toBe(true);
    expect(main("geolocation")).toBe(true);
  });

  it("refuses every permission, notifications included, on a non-allowlisted origin", () => {
    for (const permission of ["notifications", "media", "clipboard-sanitized-write"]) {
      expect(isPermissionGranted({ permission, url: "https://evilgoopter.com/", isMainFrame: true, debugOrigin: null })).toBe(false);
    }
  });

  it("refuses every permission in a subframe, even on an allowlisted origin", () => {
    for (const permission of ["notifications", "media", "clipboard-sanitized-write"]) {
      expect(
        isPermissionGranted({ permission, url: "https://x.goopter.com/odoo/point-of-sale", isMainFrame: false, debugOrigin: null }),
      ).toBe(false);
    }
  });

  it("treats the debug origin like an allowlisted origin only when it is passed", () => {
    const debug = "http://localhost:8069";
    expect(isPermissionGranted({ permission: "media", url: "http://localhost:8069/odoo", isMainFrame: true, debugOrigin: debug })).toBe(
      true,
    );
    expect(isPermissionGranted({ permission: "media", url: "http://localhost:8069/odoo", isMainFrame: true, debugOrigin: null })).toBe(
      false,
    );
  });

  it("refuses a missing or unparsable url", () => {
    expect(isPermissionGranted({ permission: "media", url: null, isMainFrame: true, debugOrigin: null })).toBe(false);
    expect(isPermissionGranted({ permission: "media", url: undefined, isMainFrame: true, debugOrigin: null })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { decideNavigation, frameRole } from "../../src/bridge/navigationPolicy.js";

/** SPEC §6.2, Android NavigationPolicyTests: navigation policy is part of the origin boundary. */
describe("NavigationPolicy", () => {
  const main = (url: string, o: { gesture?: boolean; loaded?: boolean; debug?: string } = {}) =>
    decideNavigation({
      url, isMainFrame: true, hasGesture: o.gesture ?? false, hasLoadedPage: o.loaded ?? true, debugOrigin: o.debug ?? null,
    });
  const sub = (url: string) =>
    decideNavigation({ url, isMainFrame: false, hasGesture: true, hasLoadedPage: true, debugOrigin: null });

  it("loads allowlisted pages in the POS window", () => {
    expect(main("https://jadegarden.goopter.com/pos/ui")).toBe("load");
    expect(main("https://goopter.com/")).toBe("load");
    expect(main("http://localhost:8069/odoo", { debug: "http://localhost:8069" })).toBe("load");
  });

  it("loads about and blob", () => {
    expect(main("about:blank")).toBe("load");
    expect(main("blob:https://x.goopter.com/0f2c")).toBe("load");
  });

  it("sends off-allowlist web pages to a browser", () => {
    expect(main("https://evilgoopter.com/")).toBe("openInBrowser");
    expect(main("https://www.google.com/maps", { gesture: true })).toBe("openInBrowser");
    expect(main("http://x.goopter.com/")).toBe("openInBrowser");
  });

  it("an off-allowlist start is a failure, not a browser tab", () => {
    expect(main("https://login.evil.com/", { loaded: false })).toBe("refuseStart");
    expect(main("https://x.goopter.com/web", { loaded: false })).toBe("load");
  });

  it("hands phone, mail and sms to the system only on a gesture", () => {
    for (const url of ["tel:+16045551234", "mailto:help@goopter.com", "sms:+16045551234"]) {
      expect(main(url, { gesture: true })).toBe("handToSystem");
      expect(main(url, { gesture: false })).toBe("cancel");
    }
  });

  it("cancels every other scheme", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "customapp://open",
      "ms-settings:privacy", "not a url"]) {
      expect(main(url, { gesture: true }), url).toBe("cancel");
    }
  });

  it("loads web subframes in place", () => {
    expect(sub("https://js.stripe.com/v3/")).toBe("load");
    expect(sub("http://example.com/")).toBe("load");
    expect(sub("about:blank")).toBe("load");
    expect(sub("blob:https://x.goopter.com/0f2c")).toBe("load");
    expect(sub("tel:+16045551234")).toBe("cancel");
    expect(sub("file:///etc/passwd")).toBe("cancel");
  });
});

/** Which preload API a frame gets: the POS bridge, the app's own screens, or nothing. */
describe("frameRole", () => {
  const shellPrefix = "file:///Applications/Goopter%20Smart%20POS.app/Contents/Resources/app/renderer/";
  const role = (url: string, isMainFrame = true, debugOrigin: string | null = null) =>
    frameRole({ url, isMainFrame, debugOrigin, shellUrlPrefix: shellPrefix });

  it("gives the bridge to an allowlisted main frame only", () => {
    expect(role("https://x.goopter.com/odoo/point-of-sale")).toBe("pos");
    expect(role("https://x.goopter.com/odoo/point-of-sale", false)).toBeNull();
    expect(role("https://evilgoopter.com/")).toBeNull();
    expect(role("http://localhost:8069/odoo", true, "http://localhost:8069")).toBe("pos");
  });

  it("gives the shell API to the app's own screens only", () => {
    expect(role(`${shellPrefix}store.html`)).toBe("shell");
    expect(role(`${shellPrefix}store.html`, false)).toBeNull();
    expect(role("file:///tmp/renderer/store.html")).toBeNull();
    expect(role(`${shellPrefix}../../evil.html`)).toBeNull();
  });
});

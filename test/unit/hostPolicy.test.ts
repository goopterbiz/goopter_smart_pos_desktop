import { describe, expect, it } from "vitest";
import { isAllowed, originOf } from "../../src/bridge/hostPolicy.js";

/** SPEC §6.2, Android HostPolicyTests: who may ask. */
describe("HostPolicy", () => {
  it("admits the apex and its subdomains over https", () => {
    for (const url of ["https://goopter.com", "https://goopter.com/", "https://x.goopter.com",
      "https://jadegarden.goopter.com/web?debug=0", "HTTPS://JadeGarden.Goopter.COM/pos",
      "https://a.b.goopter.com", "https://x.goopter.com:443/"]) {
      expect(isAllowed(url), url).toBe(true);
    }
  });

  it("refuses lookalikes, other hosts and other schemes", () => {
    for (const url of ["https://evilgoopter.com", "https://goopter.com.evil.com", "https://evil.com/goopter.com",
      "http://x.goopter.com", "http://goopter.com", "wss://x.goopter.com", "file:///goopter.com",
      "about:blank", "null", "", "not a url", "https://", "https://x.goopter.com."]) {
      expect(isAllowed(url), url).toBe(false);
    }
    expect(isAllowed(null)).toBe(false);
    expect(isAllowed(undefined)).toBe(false);
  });

  it("parses the authority strictly", () => {
    for (const url of ["https://evil.com\\@x.goopter.com/", "https://x.goopter.com@evil.com/", "https://x .goopter.com/"]) {
      expect(isAllowed(url), url).toBe(false);
    }
    expect(isAllowed("https://x.goopter.com/pos/ui?q={a}|b^c")).toBe(true);
  });

  it("refuses a non-default port", () => {
    expect(isAllowed("https://x.goopter.com:8443/")).toBe(false);
  });

  it("allows the debug origin exactly", () => {
    const debug = "http://localhost:8069";
    expect(isAllowed("http://localhost:8069/odoo", debug)).toBe(true);
    expect(isAllowed("http://localhost:8070/odoo", debug)).toBe(false);
    expect(isAllowed("https://localhost:8069/odoo", debug)).toBe(false);
    expect(isAllowed("http://localhost:8069/odoo")).toBe(false);
  });

  it("the origin is scheme, host and any explicit port", () => {
    expect(originOf("https://X.goopter.com/web?debug=0")).toBe("https://x.goopter.com");
    expect(originOf("http://127.0.0.1:8069/web")).toBe("http://127.0.0.1:8069");
    expect(originOf("not a url")).toBeNull();
    expect(originOf("")).toBeNull();
    expect(originOf("file:///tmp/x")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { launchUrl, MAXIMUM_LABEL_LENGTH, normalizeSlug } from "../../src/bridge/tenantSlug.js";

/** SPEC §2.2, Android TenantSlugTests N1-N13. */
describe("TenantSlug", () => {
  const normalize = (raw: string) => normalizeSlug(raw, "goopter.com");

  it("N1 accepts a plain label", () => {
    expect(normalize("jadegarden")).toBe("jadegarden");
    expect(normalize("jade-garden-2")).toBe("jade-garden-2");
    expect(normalize("2000")).toBe("2000");
  });

  it("N2 normalises what someone would paste", () => {
    for (const raw of ["JadeGarden", "  jadegarden  ", "jadegarden.goopter.com", "JadeGarden.Goopter.com",
      "https://jadegarden.goopter.com", "https://jadegarden.goopter.com/", "http://jadegarden.goopter.com/pos/ui",
      "jadegarden.goopter.com."]) {
      expect(normalize(raw)).toBe("jadegarden");
    }
  });

  it("N3 refuses anything that is not one label", () => {
    for (const raw of ["", "   ", "evil.com", "store.jadegarden", "jadegarden.goopter.com.evil.com", "..", ".",
      "jade garden", "jade_garden", "jade@garden", "jadegarden:9100", "jadegarden?x=1",
      "-jadegarden", "jadegarden-", "jade\ngarden", "jardín"]) {
      expect(normalize(raw)).toBeNull();
    }
  });

  it("N4 discards the path rather than carrying it", () => {
    expect(normalize("jadegarden.goopter.com/../evil")).toBe("jadegarden");
    expect(normalize("x/../y")).toBe("x");
    expect(normalize("/evil")).toBeNull();
  });

  it("N5 normalisation is idempotent", () => {
    for (const raw of ["jadegarden", "JADEGARDEN.GOOPTER.COM", "https://jade-garden-2.goopter.com/x", "  2000  ",
      "a", "a".repeat(MAXIMUM_LABEL_LENGTH)]) {
      const once = normalize(raw);
      if (once === null) continue;
      expect(normalize(once)).toBe(once);
    }
  });

  it("N6 refuses punycode", () => {
    expect(normalize("xn--jardn-bta")).toBeNull();
    expect(normalize("https://xn--jardn-bta.goopter.com")).toBeNull();
    expect(normalize("XN--JARDN-BTA")).toBeNull();
    expect(normalize("jade--garden")).toBe("jade--garden");
    expect(normalize("xn-jardn")).toBe("xn-jardn");
  });

  it("N7 honours the domain argument", () => {
    expect(normalizeSlug("jadegarden.example.org", "example.org")).toBe("jadegarden");
    expect(normalizeSlug("jadegarden.goopter.com", "GOOPTER.COM")).toBe("jadegarden");
    expect(normalizeSlug("jadegarden.goopter.com", "example.org")).toBeNull();
  });

  it("N8 accepts an uppercase scheme", () => {
    expect(normalize("HTTPS://JADEGARDEN.GOOPTER.COM")).toBe("jadegarden");
    expect(normalize("HTTP://JadeGarden.Goopter.Com/pos")).toBe("jadegarden");
  });

  it("N9 trims surrounding tabs and newlines", () => {
    expect(normalize("\tjadegarden\n")).toBe("jadegarden");
    expect(normalize("jadegarden\r\n")).toBe("jadegarden");
    expect(normalize("jade\tgarden")).toBeNull();
  });

  it("N10 refuses scheme-relative and doubled schemes", () => {
    expect(normalize("//evil.com")).toBeNull();
    expect(normalize("https://https://jadegarden.goopter.com")).toBeNull();
  });

  it("N11 refuses userinfo disguised as the host", () => {
    expect(normalize("https://jadegarden@evil.com")).toBeNull();
  });

  it("N12 enforces the label length limit", () => {
    const longest = "a".repeat(MAXIMUM_LABEL_LENGTH);
    expect(normalize(longest)).toBe(longest);
    expect(normalize(longest + "a")).toBeNull();
    expect(normalize(`https://${longest}.goopter.com`)).toBe(longest);
    expect(normalize(`https://${longest}a.goopter.com`)).toBeNull();
  });

  it("N13 the bare domain is not a tenant", () => {
    expect(normalize("goopter.com")).toBeNull();
    expect(normalize("https://goopter.com")).toBeNull();
  });

  it("builds the launch URL only from a valid slug", () => {
    expect(launchUrl("jadegarden")).toBe("https://jadegarden.goopter.com/odoo/point-of-sale?debug=0");
    expect(launchUrl("JadeGarden")).toBeNull();
    expect(launchUrl("evil.com")).toBeNull();
    expect(launchUrl("")).toBeNull();
  });
});

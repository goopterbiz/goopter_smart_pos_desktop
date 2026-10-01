import { describe, expect, it } from "vitest";
import { hasLocalNetworkPermission } from "../../src/bridge/localNetworkSuspicion.js";

/** SPEC §8.2. The hint names a setting, so it may only appear where that setting exists. */
describe("hasLocalNetworkPermission", () => {
  it("is true from macOS 15 (Darwin 24) on", () => {
    expect(hasLocalNetworkPermission("darwin", "24.0.0")).toBe(true);
    expect(hasLocalNetworkPermission("darwin", "25.5.0")).toBe(true);
  });

  it("is false on macOS 14 and earlier, which have no Local Network setting", () => {
    expect(hasLocalNetworkPermission("darwin", "23.6.0")).toBe(false);
    expect(hasLocalNetworkPermission("darwin", "22.1.0")).toBe(false);
  });

  it("is false on Windows and Linux, and for an unreadable release", () => {
    expect(hasLocalNetworkPermission("win32", "10.0.26100")).toBe(false);
    expect(hasLocalNetworkPermission("linux", "6.8.0")).toBe(false);
    expect(hasLocalNetworkPermission("darwin", "")).toBe(false);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The logic module must stay testable without Electron. The Android `:bridge` build fails on any
 * Android dependency; this is the same rule for `src/bridge`.
 */
describe("src/bridge boundary", () => {
  it("imports nothing from electron or the shell", () => {
    const dir = path.resolve(__dirname, "../../src/bridge");
    for (const name of readdirSync(dir)) {
      const source = readFileSync(path.join(dir, name), "utf8");
      expect(source, name).not.toMatch(/from\s+["']electron["']|require\(["']electron["']\)/);
      expect(source, name).not.toMatch(/from\s+["']\.\.\/(main|preload)\//);
    }
  });
});

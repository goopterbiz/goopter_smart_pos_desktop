import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInstalledPrinter } from "../../src/bridge/installedPrinter.js";
import { JobFailure } from "../../src/bridge/jobFailure.js";
import { ProcessSpoolerTransport, spoolCommand } from "../../src/bridge/spoolerTransport.js";
import { PAYLOAD, waitUntil } from "./support.js";

/** USB_PRINTING_SPEC "Delivery": raw bytes to the OS print queue through `lp` or the Windows helper. */
describe("spoolCommand", () => {
  it("uses lp in raw mode on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(spoolCommand(platform, "EPSON", "/unused")).toEqual({ file: "lp", args: ["-d", "EPSON", "-o", "raw"] });
    }
  });

  it("uses the bundled helper on Windows", () => {
    expect(spoolCommand("win32", "EPSON TM", "C:\\app\\rawprint.exe"))
      .toEqual({ file: "C:\\app\\rawprint.exe", args: ["EPSON TM"] });
  });
});

describe("ProcessSpoolerTransport", () => {
  const printer = resolveInstalledPrinter("EPSON", ["EPSON"]);
  const never = new AbortController().signal;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "goopter-spool-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A fake spooler: Node running `script`, with the output directory and printer name as arguments. */
  const fake = (script: string) =>
    new ProcessSpoolerTransport((name) => ({ file: process.execPath, args: ["-e", script, dir, name] }));

  const copyStdin = `
    const fs = require("node:fs");
    const [dir, name] = process.argv.slice(1);
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      fs.writeFileSync(dir + "/job.bin", Buffer.concat(chunks));
      fs.writeFileSync(dir + "/name.txt", name);
    });`;

  it("writes the bytes to the spooler's stdin and reports them written when it exits 0", async () => {
    expect(await fake(copyStdin).send(PAYLOAD, printer, never)).toBe(8);
    expect(new Uint8Array(readFileSync(path.join(dir, "job.bin")))).toEqual(PAYLOAD);
    expect(readFileSync(path.join(dir, "name.txt"), "utf8")).toBe("EPSON");
  });

  it("a non-zero exit is a refusal naming the printer", async () => {
    await expect(fake("process.stdin.resume(); process.stdin.on('end', () => process.exit(1));").send(PAYLOAD, printer, never))
      .rejects.toEqual(JobFailure.spoolerRefused("EPSON"));
  });

  it("a spooler that exits without reading is still a refusal", async () => {
    await expect(fake("process.exit(3)").send(new Uint8Array(4 * 1024 * 1024), printer, never))
      .rejects.toEqual(JobFailure.spoolerRefused("EPSON"));
  });

  it("a missing spooler program is a refusal", async () => {
    const missing = new ProcessSpoolerTransport(() => ({ file: path.join(dir, "no-such-lp"), args: [] }));
    await expect(missing.send(PAYLOAD, printer, never)).rejects.toEqual(JobFailure.spoolerRefused("EPSON"));
  });

  it("an abort kills the spooler and rejects with the signal's reason", async () => {
    const hang = `require("node:fs").writeFileSync(process.argv[1] + "/pid", String(process.pid)); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const job = fake(hang).send(PAYLOAD, printer, controller.signal);
    await waitUntil(() => existsSync(path.join(dir, "pid")));
    const reason = new Error("deadline");
    controller.abort(reason);
    await expect(job).rejects.toBe(reason);
    // Settled only once the spooler has gone, so an exit code that arrived in time is never lost.
    const pid = Number(readFileSync(path.join(dir, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("an abort cannot stall on a spooler that ignores SIGTERM", async () => {
    const stubborn = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1] + "/pid", "1"); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const job = fake(stubborn).send(PAYLOAD, printer, controller.signal);
    await waitUntil(() => existsSync(path.join(dir, "pid")));
    controller.abort(new Error("deadline"));
    await expect(job).rejects.toThrow("deadline");
  });

  it("a job aborted before it starts never runs the spooler", async () => {
    const controller = new AbortController();
    controller.abort(new Error("deadline"));
    await expect(fake(copyStdin).send(PAYLOAD, printer, controller.signal)).rejects.toThrow("deadline");
    expect(existsSync(path.join(dir, "job.bin"))).toBe(false);
  });
});

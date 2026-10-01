import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, statSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobLog, LOG_FILE_NAME } from "../../src/bridge/jobLog.js";
import type { LogEntry } from "../../src/bridge/logEntry.js";
import { PrintService } from "../../src/bridge/printService.js";
import { envelope, FakeTransport } from "./support.js";

/** SPEC §11, Android JobLogTests J1-J8. */
describe("JobLog", () => {
  let dir: string;
  const base = new Date("2026-09-23T12:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;
  const file = () => path.join(dir, LOG_FILE_NAME);

  const entry = (offsetSeconds: number, outcome = "ok"): LogEntry => ({
    timestamp: new Date(base.getTime() + offsetSeconds * 1000), event: "wrote",
    origin: "https://x.goopter.com", target: "10.0.0.1:9100", bytes: 128, durationMs: 42, outcome,
  });

  const service = (log: JobLog) =>
    new PrintService({ transport: new FakeTransport(), log: (e) => log.append(e), jobDeadlineMs: 5_000, connectTimeoutMs: 1_000 });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "joblog-"));
  });
  afterEach(() => {
    if (existsSync(file())) chmodSync(file(), 0o644);
    rmSync(dir, { recursive: true, force: true });
  });

  it("J1 entries come back newest first", async () => {
    const log = new JobLog(dir, { now: () => base });
    for (const offset of [-30, -20, -10]) await log.append(entry(offset));
    expect((await log.recent()).map((e) => e.timestamp)).toEqual([entry(-10).timestamp, entry(-20).timestamp, entry(-30).timestamp]);
    expect((await log.recent(1)).map((e) => e.timestamp)).toEqual([entry(-10).timestamp]);
  });

  it("J2 entries survive a relaunch", async () => {
    const first = new JobLog(dir, { now: () => base });
    await first.append(entry(-5));
    await first.append(entry(-4));
    expect(await new JobLog(dir, { now: () => base }).recent()).toEqual([entry(-4), entry(-5)]);
  });

  it("J3 entries older than retention are dropped on open", async () => {
    const writing = new JobLog(dir, { now: () => base, retentionMs: 7 * DAY });
    await writing.append(entry(-8 * DAY / 1000));
    await writing.append(entry(-6 * DAY / 1000));
    await writing.append(entry(-60));
    const recent = await new JobLog(dir, { now: () => base, retentionMs: 7 * DAY }).recent();
    expect(recent).toHaveLength(2);
  });

  it("J4 the size cap drops oldest first", async () => {
    const log = new JobLog(dir, { now: () => base, sizeCap: 900 });
    for (let i = 0; i < 200; i += 1) await log.append(entry(-200 + i, `job${i}`));
    const recent = await log.recent();
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.length).toBeLessThan(200);
    expect(recent[0]?.outcome).toBe("job199");
    expect(recent.some((e) => e.outcome === "job0")).toBe(false);
    expect(statSync(file()).size).toBeLessThanOrEqual(900);
  });

  it("J5 rejections record the address that was refused", async () => {
    const log = new JobLog(dir);
    await service(log).print(envelope({ host: "8.8.8.8" }), "https://x.goopter.com");
    await service(log).print(envelope({ port: 22 }), "https://x.goopter.com");
    const text = readFileSync(file(), "utf8");
    expect(text).toContain('"target":"8.8.8.8"');
    expect(text).toContain('"target":"192.168.1.50:22"');
  });

  it("J6 queued and connect events are emitted", async () => {
    const log = new JobLog(dir);
    expect((await service(log).print(envelope(), "o")).successful).toBe(true);
    const events = new Set((await log.recent()).map((e) => e.event));
    for (const event of ["queued", "connect", "wrote"]) expect(events.has(event as LogEntry["event"])).toBe(true);
  });

  it("J7 the log never contains payload bytes", async () => {
    const log = new JobLog(dir);
    const secret = "SECRETCUSTOMERNAME";
    const encoded = Buffer.from(secret).toString("base64");
    expect((await service(log).print(envelope({ base64: encoded }), "https://x.goopter.com")).successful).toBe(true);
    const text = readFileSync(file(), "utf8");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(encoded);
    expect(text).toContain("192.168.1.50:9100");
    expect(text).toContain('"bytes":18');
  });

  it("writes one JSON object per line with absent fields omitted", async () => {
    const log = new JobLog(dir, { now: () => base });
    await log.append({ timestamp: base, event: "bridge_call", origin: "https://x.goopter.com", target: "10.0.0.1:9100", bytes: 18, outcome: "accepted" });
    await log.append({ timestamp: base, event: "rejected", origin: "https://x.goopter.com", outcome: "malformed" });
    expect(readFileSync(file(), "utf8").trimEnd().split("\n")).toEqual([
      '{"timestamp":"2026-09-23T12:00:00.000Z","event":"bridge_call","origin":"https://x.goopter.com","target":"10.0.0.1:9100","bytes":18,"outcome":"accepted"}',
      '{"timestamp":"2026-09-23T12:00:00.000Z","event":"rejected","origin":"https://x.goopter.com","outcome":"malformed"}',
    ]);
  });

  it("drops a truncated line and starts the next append on a line of its own", async () => {
    const first = new JobLog(dir, { now: () => base });
    await first.append(entry(-3));
    await first.append(entry(-2));
    appendFileSync(file(), '{"timestamp":"2026-09-23T11:59:59Z","event":"wro');
    const reopened = new JobLog(dir, { now: () => base });
    expect(await reopened.recent()).toEqual([entry(-2), entry(-3)]);
    await reopened.append(entry(-1));
    expect(await new JobLog(dir, { now: () => base }).recent()).toEqual([entry(-1), entry(-2), entry(-3)]);
  });

  it("an append that cannot open the file leaves the history alone and does not throw", async () => {
    const first = new JobLog(dir, { now: () => base });
    await first.append(entry(-3));
    await first.append(entry(-2));
    const before = readFileSync(file(), "utf8");
    const failing = new JobLog(dir, { now: () => base });
    failing.appendLine = async () => { throw Object.assign(new Error("EMFILE"), { code: "EMFILE" }); };
    await failing.append(entry(-1));
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("a log that cannot be read is not replaced, and does not grow past its cap", async () => {
    if (process.getuid?.() === 0) return;
    const first = new JobLog(dir, { now: () => base });
    await first.append(entry(-3));
    await first.append(entry(-2));
    const before = readFileSync(file(), "utf8");
    const atCap = statSync(file()).size;
    chmodSync(file(), 0o200);
    const blocked = new JobLog(dir, { now: () => base, sizeCap: atCap });
    for (let i = 0; i < 5; i += 1) await blocked.append(entry(-1));
    expect(await blocked.recent()).toEqual([]);
    chmodSync(file(), 0o644);
    expect(statSync(file()).size).toBe(atCap);
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("a log that could not be read is read again once it can be", async () => {
    if (process.getuid?.() === 0) return;
    const first = new JobLog(dir, { now: () => base });
    await first.append(entry(-3));
    await first.append(entry(-2));
    chmodSync(file(), 0o200);
    const log = new JobLog(dir, { now: () => base });
    expect(await log.recent()).toEqual([]);
    chmodSync(file(), 0o644);
    await log.append(entry(-1));
    expect(await log.recent()).toEqual([entry(-1), entry(-2), entry(-3)]);
  });

  it("an append with no file yet writes the line", async () => {
    const log = new JobLog(dir, { now: () => base });
    await log.append(entry(-1));
    expect(await new JobLog(dir, { now: () => base }).recent()).toEqual([entry(-1)]);
  });

  it("a quiet till still honours retention", async () => {
    let clock = base;
    const log = new JobLog(dir, { now: () => clock, retentionMs: 7 * DAY });
    await log.append(entry(-(7 * DAY - 30 * 60 * 1000) / 1000, "old"));
    clock = new Date(base.getTime() + 2 * 60 * 60 * 1000);
    await log.append(entry(0, "new"));
    expect((await log.recent()).map((e) => e.outcome)).toEqual(["new"]);
    expect(readFileSync(file(), "utf8")).not.toContain('"old"');
  });

  it("J8 opening a full log does not read it", async () => {
    const now = new Date();
    const lines: string[] = [];
    let size = 0;
    while (size < 5 * 1024 * 1024) {
      const line = JSON.stringify({ timestamp: new Date(now.getTime() - lines.length * 1000).toISOString(), event: "wrote",
        origin: "https://jadegarden.goopter.com", target: "192.168.1.50:9100", bytes: 12480, durationMs: 143, outcome: "ok" });
      lines.push(line);
      size += line.length + 1;
    }
    writeFileSync(file(), lines.reverse().join("\n") + "\n");
    const started = performance.now();
    const log = new JobLog(dir);
    expect(performance.now() - started).toBeLessThan(20);
    expect(await log.recent(5)).toHaveLength(5);
  });
});

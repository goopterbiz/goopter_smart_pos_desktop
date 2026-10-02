import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_INTERVAL_MS, startAutoUpdate, type Updater } from "../../src/bridge/autoUpdate.js";
import { RecordingLog } from "./support.js";

/**
 * A fake standing in for the slice of electron-updater's `autoUpdater` this module touches.
 *
 * Real electron-updater emits `error` and then rejects the `checkForUpdates()` promise for one
 * failed check (AppUpdater.js `checkForUpdates`). `failNextCheck` reproduces both, so a module
 * that logged from both paths would log the failure twice here.
 *
 * A successful check resolves with `{ downloadPromise }` when `autoDownload` is on
 * (AppUpdater.js `doCheckForUpdates`). `failNextDownload` makes that promise reject after the
 * `error` event, as a failed download does.
 */
class FakeUpdater implements Updater {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checks = 0;
  quitAndInstallCalled = false;
  private failure: Error | null = null;
  private readonly listeners = new Map<string, ((arg: never) => void)[]>();

  on(event: string, listener: (arg: never) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, arg: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg as never);
  }

  private downloadFailure: Error | null = null;

  failNextCheck(error: Error): void {
    this.failure = error;
  }

  failNextDownload(error: Error): void {
    this.downloadFailure = error;
  }

  checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    const failure = this.failure;
    this.failure = null;
    if (failure !== null) {
      this.emit("error", failure);
      return Promise.reject(failure);
    }
    const downloadFailure = this.downloadFailure;
    this.downloadFailure = null;
    if (downloadFailure === null) return Promise.resolve(null);
    const downloadPromise = Promise.resolve().then(() => {
      this.emit("error", downloadFailure);
      throw downloadFailure;
    });
    return Promise.resolve({ downloadPromise });
  }

  /** Never wired to anything the module calls; present so a forced restart fails loudly. */
  quitAndInstall(): never {
    this.quitAndInstallCalled = true;
    throw new Error("autoUpdate must never force a restart");
  }
}

const withCode = (message: string, code: string): Error => Object.assign(new Error(message), { code });

/** Captured before the fake timers replace it, to wait out Node's unhandled-rejection check. */
const realSetImmediate = globalThis.setImmediate;

describe("startAutoUpdate", () => {
  let stop: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("downloads in the background and installs on the next quit, never forcing a restart", () => {
    const updater = new FakeUpdater();
    stop = startAutoUpdate(updater, new RecordingLog().append);

    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.quitAndInstallCalled).toBe(false);
  });

  it("checks once at start and again every interval", () => {
    const updater = new FakeUpdater();
    stop = startAutoUpdate(updater, new RecordingLog().append);
    expect(updater.checks).toBe(1);

    vi.advanceTimersByTime(CHECK_INTERVAL_MS - 1);
    expect(updater.checks).toBe(1);
    vi.advanceTimersByTime(1);
    expect(updater.checks).toBe(2);
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(3);
  });

  it("stops checking once stopped", () => {
    const updater = new FakeUpdater();
    stop = startAutoUpdate(updater, new RecordingLog().append);
    stop();

    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 3);
    expect(updater.checks).toBe(1);
  });

  it("logs the version when an update is found and when it has downloaded", () => {
    const updater = new FakeUpdater();
    const log = new RecordingLog();
    stop = startAutoUpdate(updater, log.append);

    updater.emit("update-available", { version: "1.0.1" });
    updater.emit("update-downloaded", { version: "1.0.1" });

    expect(log.entries).toEqual([
      expect.objectContaining({ event: "update", origin: "app", outcome: "available 1.0.1" }),
      expect.objectContaining({ event: "update", origin: "app", outcome: "downloaded 1.0.1" }),
    ]);
  });

  it("logs a failed check once, by its code, and never throws or rejects unhandled", async () => {
    const updater = new FakeUpdater();
    const log = new RecordingLog();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    updater.failNextCheck(withCode("Cannot find channel latest-mac.yml", "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"));

    try {
      stop = startAutoUpdate(updater, log.append);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
    expect(log.entries).toEqual([
      expect.objectContaining({ event: "update", origin: "app", outcome: "failed ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" }),
    ]);
  });

  it("logs a failed download once and leaves no unhandled rejection", async () => {
    const updater = new FakeUpdater();
    const log = new RecordingLog();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    updater.failNextDownload(withCode("download failed", "ERR_DL"));

    try {
      stop = startAutoUpdate(updater, log.append);
      await vi.advanceTimersByTimeAsync(0);
      // Node reports an unhandled rejection a turn after the promise rejects.
      await new Promise((resolve) => realSetImmediate(resolve));
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
    expect(log.entries).toEqual([expect.objectContaining({ event: "update", outcome: "failed ERR_DL" })]);
  });

  it("logs one error object once, even when it is emitted twice", () => {
    // F1 regression: on macOS, MacUpdater re-emits Squirrel's native error and the same object
    // rejects the download, which AppUpdater dispatches again as a second `error` event.
    const updater = new FakeUpdater();
    const log = new RecordingLog();
    stop = startAutoUpdate(updater, log.append);
    const squirrelError = withCode("Code signature did not pass validation", "ERR_SQUIRREL");

    updater.emit("error", squirrelError);
    updater.emit("error", squirrelError);
    updater.emit("error", withCode("a later, separate failure", "ERR_SQUIRREL"));

    expect(log.entries).toEqual([
      expect.objectContaining({ event: "update", outcome: "failed ERR_SQUIRREL" }),
      expect.objectContaining({ event: "update", outcome: "failed ERR_SQUIRREL" }),
    ]);
  });

  it("logs the first line of the message when an error carries no code", () => {
    const updater = new FakeUpdater();
    const log = new RecordingLog();
    stop = startAutoUpdate(updater, log.append);

    updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED\n    at SimpleURLLoaderWrapper"));

    expect(log.entries).toEqual([
      expect.objectContaining({ event: "update", outcome: "failed net::ERR_INTERNET_DISCONNECTED" }),
    ]);
  });

  it("keeps checking after a check throws synchronously", () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = () => {
      updater.checks += 1;
      throw withCode("boom", "EBOOM");
    };
    const log = new RecordingLog();

    expect(() => (stop = startAutoUpdate(updater, log.append))).not.toThrow();
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);

    expect(updater.checks).toBe(2);
    expect(log.entries).toEqual([
      expect.objectContaining({ event: "update", outcome: "failed EBOOM" }),
      expect.objectContaining({ event: "update", outcome: "failed EBOOM" }),
    ]);
  });
});

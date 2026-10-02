import { safely, type LogSink } from "./logEntry.js";

/** Long enough to be quiet, short enough that a release reaches a till that runs for days. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The slice of electron-updater's `autoUpdater` this module touches. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "update-available" | "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
}

/**
 * Check for a release now and every `CHECK_INTERVAL_MS`, download it in the background, and let
 * it install when the app next quits. Nothing here restarts the app: the till may be mid-order,
 * and the hosted POS page has no way to ask the cashier first.
 *
 * Never throws. Returns a function that stops the periodic check.
 */
export function startAutoUpdate(updater: Updater, log: LogSink): () => void {
  const record = (outcome: string) =>
    void safely(log, { timestamp: new Date(), event: "update", origin: "app", outcome });

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on("update-available", (info) => record(`available ${info.version}`));
  updater.on("update-downloaded", (info) => record(`downloaded ${info.version}`));
  // electron-updater emits `error` for a failed check or download and also rejects its promise,
  // so this listener is the one place a failure is logged. On macOS it emits Squirrel's error
  // and then dispatches the same object again when the download rejects with it.
  const logged = new WeakSet<object>();
  updater.on("error", (error) => {
    if (typeof error === "object" && error !== null) {
      if (logged.has(error)) return;
      logged.add(error);
    }
    record(`failed ${failureCode(error)}`);
  });

  const check = () => {
    try {
      updater
        .checkForUpdates()
        .then((result) => (result as { downloadPromise?: Promise<unknown> } | null)?.downloadPromise?.catch(() => {}))
        .catch(() => {});
    } catch (error) {
      record(`failed ${failureCode(error)}`);
    }
  };

  check();
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code !== "") return code;
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.trim() || "error";
}

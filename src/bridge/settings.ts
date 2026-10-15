/** The till's saved settings (C5). Stored as `settings.json` in the user data folder. */
export interface Settings {
  /** Kiosk only when the file says exactly `true`. */
  kiosk: boolean;
}

/**
 * Read `raw`, the file's text, or anything else when there is no file.
 *
 * Every doubt resolves to an ordinary window: a missing file, unreadable JSON, a document that is
 * not an object, and a `kiosk` that is not a boolean (`"true"`, `1`, `null`). Only a boolean `true`
 * enters kiosk mode.
 */
export function parseSettings(raw: unknown): Settings {
  if (typeof raw !== "string") return { kiosk: false };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kiosk: false };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kiosk: false };
  return { kiosk: (value as { kiosk?: unknown }).kiosk === true };
}

/** The dev override (`GOOPTER_WINDOWED=true`, unpackaged only) wins, then the saved setting. */
export function kioskAtLaunch(p: { windowedOverride: boolean; saved: Settings }): boolean {
  return !p.windowedOverride && p.saved.kiosk;
}

/** The till's saved settings (C5). Stored as `settings.json` in the user data folder. */
export interface Settings {
  /** Kiosk unless the file says exactly `false`. */
  kiosk: boolean;
}

/**
 * Read `raw`, the file's text, or anything else when there is no file.
 *
 * Kiosk is what a till should be, so every doubt resolves to it: a missing file, unreadable JSON, a
 * document that is not an object, and a `kiosk` that is not a boolean (`"false"`, `0`, `null`). Only
 * a boolean `false` leaves kiosk mode.
 */
export function parseSettings(raw: unknown): Settings {
  if (typeof raw !== "string") return { kiosk: true };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kiosk: true };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kiosk: true };
  return { kiosk: (value as { kiosk?: unknown }).kiosk !== false };
}

/** The dev override (`GOOPTER_WINDOWED=true`, unpackaged only) wins, then the saved setting. */
export function kioskAtLaunch(p: { windowedOverride: boolean; saved: Settings }): boolean {
  return !p.windowedOverride && p.saved.kiosk;
}

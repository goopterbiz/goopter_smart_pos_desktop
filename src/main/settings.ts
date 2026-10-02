import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { parseSettings, type Settings } from "../bridge/settings.js";

/** The till's saved settings (C5). Every read goes through `parseSettings`, so a bad file means kiosk. */
const file = () => path.join(app.getPath("userData"), "settings.json");

export function readSettings(): Settings {
  let text: string | undefined;
  try {
    text = readFileSync(file(), "utf8");
  } catch {
    // Missing or unreadable: parseSettings reads that as kiosk.
  }
  return parseSettings(text);
}

export function writeSettings(settings: Settings): void {
  writeFileSync(file(), JSON.stringify({ kiosk: settings.kiosk }));
}

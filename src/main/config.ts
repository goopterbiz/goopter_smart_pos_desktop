import path from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";
import { originOf } from "../bridge/hostPolicy.js";

/**
 * Development overrides. Every one is read only in an unpackaged build: a shipped build that
 * trusted an environment variable would trust anything that could set one.
 *
 * - `GOOPTER_DEBUG_URL`: load this address instead of the saved store and skip the store screen.
 *   Its origin is allowlisted exactly, so the bridge is exposed against a local Odoo.
 * - `GOOPTER_USER_DATA`: keep settings, the log and cookies somewhere else, for isolated tests.
 * - `GOOPTER_WINDOWED=1`: an ordinary window instead of kiosk, with developer tools.
 */
const dev = !app.isPackaged;

export const debugUrl: string | null = (() => {
  const raw = dev ? process.env.GOOPTER_DEBUG_URL : undefined;
  return raw && originOf(raw) !== null ? raw : null;
})();

export const debugOrigin: string | null = debugUrl === null ? null : originOf(debugUrl);

export const userDataOverride: string | null = (dev && process.env.GOOPTER_USER_DATA) || null;

export const windowed = dev && process.env.GOOPTER_WINDOWED === "1";

/** The app's own screens. Anything under this URL gets the shell API and nothing else does. */
export const rendererDir = path.join(__dirname, "..", "..", "renderer");
export const shellUrlPrefix = pathToFileURL(rendererDir + path.sep).href;

export const preloadPath = path.join(__dirname, "..", "preload", "preload.js");

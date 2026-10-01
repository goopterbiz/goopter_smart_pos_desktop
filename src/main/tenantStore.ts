import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { TENANT_DOMAIN } from "../bridge/constants.js";
import { launchUrl, normalizeSlug } from "../bridge/tenantSlug.js";
import { debugUrl } from "./config.js";

/**
 * The store this till opens (SPEC §2.2). The slug is stored, not the URL: the scheme and domain
 * are the app's to decide, and a stored value is re-checked on every read.
 */
const file = () => path.join(app.getPath("userData"), "store.json");

/** The page to open at launch, or null when the store screen is needed. */
export function storedLaunchUrl(): string | null {
  if (debugUrl !== null) return debugUrl;
  try {
    const { slug } = JSON.parse(readFileSync(file(), "utf8")) as { slug?: unknown };
    return typeof slug === "string" ? launchUrl(slug) : null;
  } catch {
    return null;
  }
}

/** Save what was typed, or return null when it is not a store name. */
export function saveStore(raw: string): string | null {
  const slug = normalizeSlug(raw, TENANT_DOMAIN);
  const url = slug === null ? null : launchUrl(slug);
  if (slug === null || url === null) return null;
  writeFileSync(file(), JSON.stringify({ slug }));
  return url;
}

export function clearStore(): void {
  rmSync(file(), { force: true });
}

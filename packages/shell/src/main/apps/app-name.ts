/**
 * Resolve an installed app's human display name from its manifest, with a
 * cache the installer invalidates (`forgetAppName`). Shared by the window index (`resolveAppMeta`) and
 * the Settings → Defaults catalog so the friendly name is read one way.
 *
 * Falls back to the app id when the app isn't active or its manifest is
 * unreadable — callers always get a non-empty string.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppsRepository } from "../storage/registry-repo/apps-repo";

const appNameCache = new Map<string, string>();

/** Drop an app's cached name. The installer calls this whenever what the name
 *  describes changes — install, update, uninstall — because the name is shown
 *  as "who is asking" on security prompts: a stale one shows an updated app
 *  under its old name, or a reinstalled id under its predecessor's. */
export function forgetAppName(appId: string): void {
	appNameCache.delete(appId);
}

export function resolveAppName(appsRepo: AppsRepository, appId: string): string {
	const cached = appNameCache.get(appId);
	if (cached) return cached;
	const record = appsRepo.getActive(appId);
	if (!record) return appId;
	try {
		const raw = readFileSync(join(record.bundleDir, "manifest.json"), "utf8");
		const manifest = JSON.parse(raw) as { name?: unknown };
		if (typeof manifest.name === "string" && manifest.name.length > 0) {
			appNameCache.set(appId, manifest.name);
			return manifest.name;
		}
	} catch {
		// Manifest unreadable — fall through with `appId` as display.
	}
	return appId;
}

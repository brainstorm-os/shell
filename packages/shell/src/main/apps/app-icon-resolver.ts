/**
 * `brainstorm://app-icon/<appId>` resolution — which file (if any) backs an
 * app's icon, and WHY there isn't one.
 *
 * The distinction is the point. An installed app that declares no `icon` is a
 * normal, expected state: every icon surface already draws a deterministic
 * initials tile for it. Answering that with a 404 turned "this app has no
 * artwork" into a console error on every surface that renders the app, every
 * boot — four per run for two icon-less sideloaded apps, and the only console
 * errors in the VID-build-apps capture (POLISH-LAY-8). It answers 204 instead.
 * A 404 stays reserved for an id that resolves to nothing installed, which IS
 * worth surfacing.
 *
 * Path containment (the icon must stay inside the app's own bundle) is part of
 * the resolution, not the caller's job.
 */

import { readFile, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

export enum AppIconMiss {
	/** No session, no active record for this id, or an unreadable manifest — a
	 *  real miss the caller should see. */
	Unresolved = "unresolved",
	/** Installed, but the manifest declares no in-bundle icon. Not an error. */
	NoIcon = "no-icon",
}

export type AppIconResolution = { path: string } | { miss: AppIconMiss };

export function isAppIconHit(resolution: AppIconResolution): resolution is { path: string } {
	return "path" in resolution;
}

/** HTTP status for a miss — 204 (no content) for a declared-no-icon app so the
 *  caller's initials fallback runs quietly; 404 for an unresolvable id. */
export function appIconMissStatus(miss: AppIconMiss): number {
	return miss === AppIconMiss.NoIcon ? 204 : 404;
}

export type AppIconResolverIo = {
	/** Read `<bundleDir>/manifest.json`. */
	readManifest: (dir: string) => Promise<string>;
	/** Does the resolved icon file exist on disk? */
	fileExists: (path: string) => Promise<boolean>;
};

const DEFAULT_IO: AppIconResolverIo = {
	readManifest: (dir) => readFile(join(dir, "manifest.json"), "utf8"),
	fileExists: (path) =>
		stat(path).then(
			() => true,
			() => false,
		),
};

/** Resolve the icon file inside an installed app's bundle. `bundleDir` is
 *  `null` when no active record exists for the id. `io` is injectable for
 *  tests.
 *
 *  A declared icon that isn't actually on disk resolves to `NoIcon`, not to a
 *  path: letting the caller `net.fetch` a missing `file://` surfaces as an
 *  `ERR_UNEXPECTED` in the renderer rather than a clean status (the same trap
 *  the emoji handler already guards). Either way the app has no usable
 *  artwork, which is exactly what `NoIcon` means. */
export async function resolveAppIconInBundle(
	bundleDir: string | null,
	io: Partial<AppIconResolverIo> = {},
): Promise<AppIconResolution> {
	if (!bundleDir) return { miss: AppIconMiss.Unresolved };
	const { readManifest, fileExists } = { ...DEFAULT_IO, ...io };
	let manifest: { icon?: unknown };
	try {
		manifest = JSON.parse(await readManifest(bundleDir)) as { icon?: unknown };
	} catch {
		return { miss: AppIconMiss.Unresolved };
	}
	if (typeof manifest.icon !== "string" || manifest.icon.length === 0) {
		return { miss: AppIconMiss.NoIcon };
	}
	if (manifest.icon.includes("..")) return { miss: AppIconMiss.NoIcon };
	const target = normalize(join(bundleDir, manifest.icon));
	if (!target.startsWith(bundleDir + sep) && target !== bundleDir) {
		return { miss: AppIconMiss.NoIcon };
	}
	if (!(await fileExists(target))) return { miss: AppIconMiss.NoIcon };
	return { path: target };
}

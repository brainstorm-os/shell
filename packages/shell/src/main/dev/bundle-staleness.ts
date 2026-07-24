/**
 * Dev-boot build gate: is an app's `dist/` older than the sources that
 * produce it?
 *
 * The dev seeder rebuilds EVERY first-party app on every boot — a vite spawn
 * each, which `seed-demo-apps` itself records as "~200s for 11 source
 * rebuilds". There are 20 apps now, and a typical boot changes none of them,
 * so nearly all of that is spent rebuilding byte-identical output. The install
 * side already guards against this (it hashes the bundle and skips an
 * unchanged reinstall); the BUILD side did not, so the shell paid the whole
 * cost before reaching that check.
 *
 * This is the missing gate: compare the newest mtime among an app's inputs
 * against the newest artifact in its `dist/`. Fresh ⇒ skip the spawn.
 *
 * **Inputs include the shared packages.** An app's bundle also depends on
 * `@brainstorm-os/sdk`, `sdk-types`, `editor`, … so touching a shared package
 * must invalidate every app — otherwise a dev edits the SDK, sees no change in
 * a running app, and concludes the shell didn't restart. Erring that way costs
 * a rebuild; erring the other way costs an afternoon.
 *
 * Deliberately mtime-based, not content-hashed: this runs on the boot path for
 * 20 apps, and the whole point is to be much cheaper than the build it guards.
 * A false "stale" only rebuilds; there is no correctness risk either way.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directories inside an app bundle that never affect its build output. */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
	"dist",
	"node_modules",
	".vite",
	".vite-temp",
	".turbo",
]);

/** The newest mtime under `dir`, or 0 when it can't be read / is empty. */
function newestMtime(dir: string, depth = 0): number {
	if (depth > 12) return 0;
	let newest = 0;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	for (const name of entries) {
		if (name.startsWith(".") && name !== ".") continue;
		if (IGNORED_DIRS.has(name)) continue;
		const full = join(dir, name);
		let info: ReturnType<typeof statSync>;
		try {
			info = statSync(full);
		} catch {
			continue;
		}
		const stamp = info.isDirectory() ? newestMtime(full, depth + 1) : info.mtimeMs;
		if (stamp > newest) newest = stamp;
	}
	return newest;
}

export type BundleStalenessInput = {
	/** The app's bundle directory (holds `src/`, `manifest.json`, `dist/`). */
	appBundleDir: string;
	/** Shared source roots the bundle also compiles in — typically each
	 *  `packages/<name>/src`. A change in any of them invalidates every app. */
	sharedSourceRoots?: readonly string[];
};

/**
 * True when the app must be rebuilt: no `dist/` yet, or some input is newer
 * than the newest artifact in it. Any doubt (unreadable directory, empty
 * `dist/`) resolves to **stale** — a needless rebuild is the safe error.
 */
export function isBundleBuildStale(input: BundleStalenessInput): boolean {
	const builtAt = newestMtime(join(input.appBundleDir, "dist"), 11);
	if (builtAt === 0) return true;

	const ownSources = newestMtime(input.appBundleDir);
	if (ownSources > builtAt) return true;

	for (const root of input.sharedSourceRoots ?? []) {
		if (newestMtime(root) > builtAt) return true;
	}
	return false;
}

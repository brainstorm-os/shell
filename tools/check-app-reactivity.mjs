#!/usr/bin/env node
/**
 * App-reactivity ratchet.
 *
 * The architecture decision : a reactive
 * app — anything backed by vault entities that updates from other
 * devices/users — reads live entity lists through the ONE shared stack,
 * `@brainstorm-os/react-yjs`'s `useVaultEntities` / `useLiveEntities`. It must
 * NOT hand-roll `vaultEntities.onChange → list() → setState/render`: that
 * re-implements the reactivity layer per app (the drift that produced the
 * bookmarks scroll-blink and a different coalescer in every app).
 *
 * Biome 1.9 can't express a custom "no this call here" rule, so this is a
 * grep-grade gate with a shrinking baseline. Every file that currently
 * subscribes to the coarse `vaultEntities` change signal is grandfathered
 * in `app-reactivity-baseline.json`. The gate fails when:
 *   - a NON-baselined app file subscribes (a new violation — this is the
 *     ratchet: new code and new apps must use the shared hooks), or
 *   - a baselined file no longer subscribes (it was migrated — remove it
 *     from the baseline so the list can only shrink).
 *
 * Run by `bun run lint` and `bun run verify`. As Step (3) migrates apps,
 * baseline entries get deleted until the file is empty and the gate becomes
 * an absolute ban.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_DIR = join(ROOT, "apps");
const BASELINE_PATH = join(ROOT, "tools", "app-reactivity-baseline.json");

/** Strip block + line comments so a reference inside a doc-comment (the
 *  `coalesce.ts` / `styles.css` mentions of the pattern) is never flagged.
 *  Good-enough lexing for a heuristic gate — the `[^:]` guard keeps `://`
 *  in string URLs from being treated as a line comment. */
function stripComments(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Seams where handing the coarse signal onward is the SANCTIONED pattern, not
 * debt. Both take an `{ list, onChange }` source and own the coalescing
 * themselves, which is exactly what this gate wants apps to do:
 *
 *   - `useLiveEntities` / `useVaultEntities` — the shared reactivity hooks. An
 *     app that reads through a type-scoped `entities.query` (because it holds
 *     per-type caps rather than the `entities.read:*` wildcard) MUST pass
 *     `onChange` in as the change tap; there is no other way to drive it.
 *   - `setEntityIndexSource` — `@brainstorm-os/editor`'s entity index is
 *     deliberately decoupled from any app runtime, so the host injects the
 *     source once at boot.
 *
 * Flagging these was actively harmful, not just noisy: a reader draining the
 * baseline would "migrate" Books to `vaultEntities.list()` — the wildcard
 * capability Books deliberately does NOT hold, which is the exact mismatch that
 * once made imported books silently invisible.
 */
const SANCTIONED_SINKS = /\b(useLiveEntities|useVaultEntities|setEntityIndexSource)\b/;

/**
 * A file "subscribes to the coarse vault signal" when it references the
 * `vaultEntities` service AND calls some `.onChange` in real code — UNLESS every
 * such reference is being handed to one of the sanctioned sinks above.
 *
 * The heuristic is file-grade, matching the rest of this gate: if the file
 * mentions a sanctioned sink at all, its `onChange` is presumed to be feeding
 * it. That trades a little precision for zero false alarms on compliant code,
 * and the ratchet still catches a NEW hand-rolled loop in any file that does not
 * use the shared hooks — which is the case it exists for.
 */
function subscribesToVault(src) {
	const code = stripComments(src);
	if (!/\bvaultEntities\b/.test(code) || !/\.onChange\b/.test(code)) return false;
	return !SANCTIONED_SINKS.test(code);
}

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist") continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			yield* walk(full);
		} else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
			yield full;
		}
	}
}

const toPosix = (p) => relative(ROOT, p).split("\\").join("/");

const offenders = [];
for (const file of walk(APPS_DIR)) {
	if (subscribesToVault(readFileSync(file, "utf8"))) offenders.push(toPosix(file));
}
offenders.sort();

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).files;
const baselineSet = new Set(baseline);
const offenderSet = new Set(offenders);

const newViolations = offenders.filter((f) => !baselineSet.has(f));
const staleBaseline = baseline.filter((f) => !offenderSet.has(f));

if (newViolations.length === 0 && staleBaseline.length === 0) {
	console.log(
		`✓ app-reactivity: ${offenders.length} baselined raw vaultEntities.onChange usage(s), no new ones.`,
	);
	process.exit(0);
}

if (newViolations.length > 0) {
	console.error("\n✗ app-reactivity: new raw `vaultEntities.onChange` subscription(s) — use");
	console.error("  `@brainstorm-os/react-yjs` `useVaultEntities` / `useLiveEntities` instead:\n");
	for (const f of newViolations) console.error(`    ${f}`);
	console.error(
		"\n  (See docs/apps/09-shared-sdk-catalog.md → 'Live entity lists'. If this app is a\n   genuinely non-reactive render surface, it should not be touching vaultEntities at all.)",
	);
}

if (staleBaseline.length > 0) {
	console.error("\n✗ app-reactivity: baselined file(s) no longer subscribe — migrated! Remove them");
	console.error(`  from ${toPosix(BASELINE_PATH)} so the ratchet stays tight:\n`);
	for (const f of staleBaseline) console.error(`    ${f}`);
}

console.error("");
process.exit(1);

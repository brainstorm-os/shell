#!/usr/bin/env node
/**
 * App i18n declaration gate (12.15 slice 15c).
 *
 * An app opts into per-app localization by declaring `i18n: { source, locales }`
 * in its `manifest.json`. `source` is the language the inline `t()` manifest is
 * authored in (English today); `locales` is the full set the app ships — the
 * source plus every overlay pack under `src/i18n/<tag>.json`. English needs no
 * pack (it IS the inline manifest); the other tags each carry a `Partial<M>` of
 * the keys they translate, merged over the manifest by `createT`.
 *
 * This gate keeps the declaration honest:
 *   1. every DECLARED non-source locale has a `src/i18n/<tag>.json` file,
 *   2. that file is valid JSON of `string → string`,
 *   3. no overlay file on disk is left UNdeclared (orphan packs drift),
 *   4. when the source catalog is resolvable, every pack key exists in it (a
 *      typo'd or stale key in an overlay never silently ships),
 *   5. when the source is an extracted `<source>.json` catalog, every pack
 *      carries every source key — a string added to en.json without its
 *      translations ships English to every other locale, and nothing else
 *      notices (seven apps fell behind this way in one release).
 *
 * Apps that don't declare `i18n` are skipped — adoption is opt-in (the rest of
 * the fleet rides the documented English fallback until their packs land, 15d).
 *
 * Pure core (`auditAppI18n`) is unit-tested; the disk walker runs in `bun run
 * lint`. Node-only (fs + JSON) — no TS imports, so plain `node` runs it.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pure audit of one app's i18n declaration against what's on disk.
 *
 * @param {object} input
 * @param {string} input.appId
 * @param {{ source: string, locales: string[] }} input.decl
 * @param {string[] | null} input.sourceKeys  source catalog keys, or null to skip the subset check
 * @param {Record<string, { ok: true, keys: string[] } | { ok: false, error: string } | undefined>} input.packs
 *        resolved overlay packs for each declared non-source locale (undefined = file missing)
 * @param {string[]} input.discoveredLocales  locale tags found as `src/i18n/<tag>.json` on disk
 * @param {boolean} [input.requireComplete]  every source key must appear in every pack
 * @returns {string[]} human-readable errors (empty = clean)
 */
export function auditAppI18n({
	appId,
	decl,
	sourceKeys,
	packs,
	discoveredLocales,
	requireComplete = false,
}) {
	const errors = [];
	if (!decl.locales.includes(decl.source)) {
		errors.push(`${appId}: i18n.source "${decl.source}" is not listed in i18n.locales`);
	}

	const sourceKeySet = sourceKeys ? new Set(sourceKeys) : null;
	for (const locale of decl.locales) {
		if (locale === decl.source) continue;
		const pack = packs[locale];
		if (pack === undefined) {
			errors.push(`${appId}: declared locale "${locale}" has no src/i18n/${locale}.json`);
			continue;
		}
		if (!pack.ok) {
			errors.push(`${appId}: src/i18n/${locale}.json is not valid JSON (${pack.error})`);
			continue;
		}
		if (sourceKeySet) {
			const unknown = pack.keys.filter((k) => !sourceKeySet.has(k));
			if (unknown.length > 0) {
				const shown = unknown.slice(0, 5).join(", ");
				const more = unknown.length > 5 ? `, …(+${unknown.length - 5})` : "";
				errors.push(
					`${appId}: src/i18n/${locale}.json has keys absent from the source catalog: ${shown}${more}`,
				);
			}
		}
		if (sourceKeys && requireComplete) {
			const packKeySet = new Set(pack.keys);
			const missing = sourceKeys.filter((k) => !packKeySet.has(k));
			if (missing.length > 0) {
				const shown = missing.slice(0, 5).join(", ");
				const more = missing.length > 5 ? `, …(+${missing.length - 5})` : "";
				errors.push(`${appId}: src/i18n/${locale}.json is missing source keys: ${shown}${more}`);
			}
		}
	}

	for (const locale of discoveredLocales) {
		if (locale === decl.source) continue;
		if (!decl.locales.includes(locale)) {
			errors.push(`${appId}: src/i18n/${locale}.json exists but is not declared in i18n.locales`);
		}
	}

	return errors;
}

/** Resolve the source-language key set: an extracted `<source>.json` catalog if
 *  present, else the flat `"key":` literals in the inline `src/i18n.ts` /
 *  `src/i18n/t.ts` manifest, else null (subset check skipped). */
function resolveSourceKeys(appDir, source) {
	const sourceJson = join(appDir, "src", "i18n", `${source}.json`);
	if (existsSync(sourceJson)) {
		try {
			return Object.keys(JSON.parse(readFileSync(sourceJson, "utf8")));
		} catch {
			return null;
		}
	}
	for (const rel of ["src/i18n.ts", "src/i18n/t.ts"]) {
		const file = join(appDir, rel);
		if (!existsSync(file)) continue;
		const text = readFileSync(file, "utf8");
		// Best-effort: matches one `"key":` per line, which is how the inline
		// manifests are authored. A single-line or nested manifest would
		// under-collect here — the exact path is the extracted `<source>.json`
		// above; this regex is only the fallback when no such file exists.
		const keys = [...text.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1]);
		if (keys.length > 0) return keys;
	}
	return null;
}

function main() {
	const appsDir = join(ROOT, "apps");
	const errors = [];

	for (const appId of readdirSync(appsDir)) {
		const manifestPath = join(appsDir, appId, "manifest.json");
		if (!existsSync(manifestPath)) continue;
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch (error) {
			errors.push(`${appId}: manifest.json is not valid JSON (${error.message ?? error})`);
			continue;
		}
		const decl = manifest.i18n;
		if (!decl) continue;

		const i18nDir = join(appsDir, appId, "src", "i18n");
		const discoveredLocales = existsSync(i18nDir)
			? readdirSync(i18nDir)
					.filter((f) => f.endsWith(".json"))
					.map((f) => f.slice(0, -".json".length))
			: [];

		const packs = {};
		for (const locale of decl.locales) {
			if (locale === decl.source) continue;
			const packPath = join(i18nDir, `${locale}.json`);
			if (!existsSync(packPath)) {
				packs[locale] = undefined;
				continue;
			}
			try {
				packs[locale] = { ok: true, keys: Object.keys(JSON.parse(readFileSync(packPath, "utf8"))) };
			} catch (error) {
				packs[locale] = { ok: false, error: String(error.message ?? error) };
			}
		}

		const sourceKeys = resolveSourceKeys(join(appsDir, appId), decl.source);
		const requireComplete = existsSync(join(i18nDir, `${decl.source}.json`));
		errors.push(
			...auditAppI18n({ appId, decl, sourceKeys, packs, discoveredLocales, requireComplete }),
		);
	}

	if (errors.length > 0) {
		console.error("App i18n declaration gate failed:\n");
		for (const e of errors) console.error(`  ✗ ${e}`);
		console.error(
			"\nDeclare every shipped overlay in manifest.json `i18n.locales`, ship a src/i18n/<tag>.json for each, keep pack keys within the source catalog, and translate every key an extracted source catalog adds.",
		);
		process.exit(1);
	}
}

// Only walk the filesystem when run directly; importing for tests stays pure.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}

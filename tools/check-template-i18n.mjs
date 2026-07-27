/**
 * Workflow-template i18n coverage — zero baseline.
 *
 * Every template in `WORKFLOW_TEMPLATES` must have `name` / `desc` / `trigger`
 * in EVERY locale catalog, because the template gallery is the Automations app's
 * empty state: it is the literal first thing a user with no workflows sees.
 *
 * This exists because two templates shipped without any catalog entries and the
 * gallery rendered raw key ids — `template.triage-new-email.name` — on that
 * first screen, in every locale, for two releases. Found by dogfooding the real
 * vault (session 915), not by any gate.
 *
 * **Why nothing caught it.** The view builds its keys dynamically:
 *
 *     t(`template.${template.id}.name` as AutomationsI18nKey)
 *
 * The template literal hides the key from `check-app-i18n.mjs`, which can only
 * see literal arguments, and the `as` cast suppresses the type error that would
 * otherwise have flagged an unknown key. Two independent safety nets, both
 * blinded by the same two lines. A dynamically-keyed lookup needs a check that
 * knows the key SHAPE — which is exactly this file.
 *
 * The strings also exist twice: `templates.ts` carries English `name` /
 * `description` / `triggerSummary` inline, and the catalog carries the
 * translated copies. That duplication is what let one side be populated and the
 * other forgotten; this gate pins them together until the duplication is removed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REGISTRY = "apps/automations/src/logic/templates.ts";
const LOCALE_DIR = "apps/automations/src/i18n";
const PARTS = ["name", "desc", "trigger"];

/**
 * Template ids declared in `WORKFLOW_TEMPLATES`.
 *
 * Scoped to the array body rather than the whole file: a bare `id:` scan also
 * matches step ids (`id: "trigger"`), which is a false positive that would make
 * the gate demand catalog keys for things that are not templates.
 */
export function templateIdsFrom(source) {
	const start = source.indexOf("WORKFLOW_TEMPLATES");
	if (start === -1) return [];
	// The registry is one frozen array literal; stop at the line that closes it.
	const rest = source.slice(start);
	const end = rest.indexOf("\n]);");
	const body = end === -1 ? rest : rest.slice(0, end);
	// Only `id:` at the template-object depth (one tab inside the array).
	return [...body.matchAll(/^\t\tid:\s*"([a-z0-9-]+)"/gm)].map((m) => m[1]);
}

/** Keys a template id requires. */
export function requiredKeys(id) {
	return PARTS.map((part) => `template.${id}.${part}`);
}

/** Missing `{locale, key}` pairs across every catalog. */
export function findMissingTemplateKeys(ids, catalogs) {
	const missing = [];
	for (const [locale, catalog] of Object.entries(catalogs)) {
		for (const id of ids) {
			for (const key of requiredKeys(id)) {
				const value = catalog[key];
				if (typeof value !== "string" || value.trim() === "") {
					missing.push({ locale, key });
				}
			}
		}
	}
	return missing;
}

function main() {
	const ids = templateIdsFrom(readFileSync(REGISTRY, "utf8"));
	if (ids.length === 0) {
		console.error(`✗ template-i18n: found no template ids in ${REGISTRY} — did the registry move?`);
		process.exit(1);
	}
	const catalogs = {};
	for (const file of readdirSync(LOCALE_DIR)) {
		if (!file.endsWith(".json")) continue;
		catalogs[file.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(LOCALE_DIR, file), "utf8"));
	}

	const missing = findMissingTemplateKeys(ids, catalogs);
	if (missing.length > 0) {
		console.error(
			`✗ template-i18n: ${missing.length} missing key(s). The template gallery is the Automations\n  empty state — a missing key renders the raw key id on the first screen a user sees.\n  Keys are built dynamically, so neither check-app-i18n nor tsc can catch this.\n`,
		);
		for (const m of missing) console.error(`    ${m.locale}.json — ${m.key}`);
		process.exit(1);
	}
	console.log(
		`✓ template-i18n: ${ids.length} templates × ${PARTS.length} keys × ${Object.keys(catalogs).length} locales all present.`,
	);
}

if (process.argv[1]?.endsWith("check-template-i18n.mjs")) main();

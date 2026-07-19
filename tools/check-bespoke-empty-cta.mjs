/**
 * Bespoke empty-state CTA ratchet (F-444). An empty surface that offers a
 * primary CTA must be the shared `<EmptyState>` — its hero face enforces the
 * lg button geometry (F-441). Hand-rolled `<div className="x__empty"><p>…</p>
 * <button data-bs-primary…` blocks are exactly how the small-radius CTA
 * keeps reshipping one app at a time (Mailbox F-437 → Code-editor F-441 →
 * Bookmarks F-444).
 *
 * Heuristic: a `__empty`-suffixed className NOT sitting on a `<EmptyState`
 * element whose following 600 chars contain `data-bs-primary`. Zero
 * baseline — any hit fails. `<p>`-only hints and secondary buttons pass.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walkTsx(dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry === "node_modules") continue;
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) walkTsx(full, out);
		else if (full.endsWith(".tsx")) out.push(full);
	}
	return out;
}

const files = readdirSync("apps").flatMap((app) => walkTsx(join("apps", app, "src")));
const offenders = [];

for (const file of files) {
	if (file.includes(".test.")) continue;
	const src = readFileSync(file, "utf8");
	const re = /className="[a-z][a-z-]*__empty[a-z-]*"/g;
	for (const match of src.matchAll(re)) {
		const before = src.slice(Math.max(0, match.index - 300), match.index);
		const lastOpen = before.lastIndexOf("<");
		const openingTag = lastOpen >= 0 ? before.slice(lastOpen) : "";
		// The shared component itself, or a plain text hint (<p>/<span>) with a
		// coincidentally-nearby toolbar button, are both fine.
		if (openingTag.startsWith("<EmptyState")) continue;
		if (openingTag.startsWith("<p") || openingTag.startsWith("<span")) continue;
		const after = src.slice(match.index, match.index + 600);
		if (after.includes("data-bs-primary")) {
			offenders.push(`${file}: ${match[0]}`);
		}
	}
}

if (offenders.length > 0) {
	console.error(
		"✗ bespoke empty-state CTA(s) — use the shared <EmptyState> (hero face enforces the button geometry):",
	);
	for (const o of offenders) console.error(`    ${o}`);
	process.exit(1);
}
console.log("✓ empty-state CTAs: every primary-CTA empty surface uses the shared <EmptyState>.");

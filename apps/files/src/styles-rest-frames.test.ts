/**
 * Rest-state frame guard — the "no frames around things at rest" ratchet.
 *
 * Files' layouts have regressed repeatedly with unwanted borders / outlines /
 * shadow rings ("frames") around tiles, rows and whole containers:
 *   • f9e55cb — grid tiles shipped an always-on card border + elevated
 *     surface that read as an outline around every icon;
 *   • F-374 (22cabd2) — the shared focus-ring rule framed composite-widget
 *     containers (the whole file list got a 2px rectangle);
 *   • F-304 (a6478fd) — hand-rolled inputs re-invented bordered boxes the
 *     shared `.bs-input` face already owns.
 *
 * The design intent, recorded in f9e55cb: tiles and rows are BORDERLESS at
 * rest. Where hover / selection needs to tint a border without a layout
 * shift, the rest state keeps a *transparent* border track
 * (`border: var(--border-width) solid transparent`) — never a painted one.
 *
 * This test parses every stylesheet under `apps/files/src` and fails when a
 * rest-state rule (no `:hover` / `:focus*` / selection- or drag-state
 * attribute anywhere in the selector) whose subject is one of the guarded
 * tile / row / container classes declares a non-transparent `border`,
 * `border-color`, `outline` or `box-shadow`.
 *
 * NOT flagged (on purpose):
 *   • single-edge borders (`border-top`, `border-inline-end`, …) — those are
 *     panel dividers, not frames;
 *   • state rules (hover / focus / selected / drop-target / dragging / …);
 *   • non-guarded elements — dialogs, popovers, toasts, chips, badges and
 *     hover-revealed corner grips wear intentional frames.
 *
 * Adding an INTENTIONAL frame to a guarded surface? Add an ALLOWLIST entry
 * below with a reason, so the exception is a reviewed decision instead of a
 * silent regression.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Class names (without the leading dot) whose REST state must not paint a
 *  full-perimeter frame. Matched against the selector's subject compound —
 *  the last simple-selector group, i.e. the element the rule actually
 *  paints. Extend this list when a new tile / row / container class lands. */
const GUARDED_CLASSES = new Set([
	// content pane — tiles + rows in every view mode
	"content-row",
	"content-row__menu-host",
	"content-list",
	"content-list__group-heading",
	"content-empty",
	"content",
	"window",
	"toolbar",
	// sidebar rows + panel
	"sidebar",
	"sidebar__section",
	"sidebar__list",
	"sidebar__tree-row",
	"smart-folders__row",
	"smart-folders__open",
	// inspector panel + storage rows
	"inspector",
	"inspector__body",
	"storage-row",
	"storage-row__inner",
	"storage-row__open",
]);

/** Full-perimeter frame properties. Single-edge borders (dividers) are
 *  deliberately absent. */
const FRAME_PROPS = new Set(["border", "border-color", "outline", "outline-color", "box-shadow"]);

/** A selector containing any of these anywhere is a STATE rule, not a rest
 *  rule — hover / keyboard-focus / selection / drag affordances may tint the
 *  (transparent) track. */
const STATE_MARKERS =
	/:(?:hover|active|focus|focus-visible|focus-within)\b|\[(?:data-selected|data-drop-target|data-cross-over|data-dragging|data-os-drop|data-shown|data-active|data-current|data-static|aria-selected|aria-current|aria-expanded)\b|\.is-resizing\b/;

/** Reviewed, intentional frames on guarded surfaces: `"<selector> :: <prop>"`
 *  → reason. Keep reasons honest — they are the review record. */
const ALLOWLIST = new Map<string, string>([
	[
		'body[data-inspector="open"] .inspector :: box-shadow',
		"floating glass overlay panel — elevation shadow while open is the design (matches Notes/Database), not a frame",
	],
	[
		".inspector :: box-shadow",
		"floating glass overlay panel — elevation shadow is the design (matches Notes/Database), not a frame",
	],
]);

type Declaration = { prop: string; value: string };
type Rule = { selector: string; declarations: Declaration[] };

function collectCssFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...collectCssFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".css")) out.push(path);
	}
	return out;
}

function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Minimal flat-CSS parser: returns every `selector { decls }` rule,
 *  descending into conditional group at-rules (`@media`, `@supports`, …). */
function parseRules(css: string): Rule[] {
	const rules: Rule[] = [];
	walk(stripComments(css));
	return rules;

	function walk(block: string): void {
		let i = 0;
		while (i < block.length) {
			const open = block.indexOf("{", i);
			if (open === -1) break;
			const header = block.slice(i, open).trim();
			let depth = 1;
			let j = open + 1;
			while (j < block.length && depth > 0) {
				if (block[j] === "{") depth += 1;
				else if (block[j] === "}") depth -= 1;
				j += 1;
			}
			const body = block.slice(open + 1, j - 1);
			if (header.startsWith("@")) {
				if (/^@(?:media|supports|layer|container|scope)\b/.test(header)) walk(body);
			} else if (header !== "") {
				rules.push({
					selector: header.replace(/\s+/g, " "),
					declarations: parseDeclarations(body),
				});
			}
			i = j;
		}
	}
}

function parseDeclarations(body: string): Declaration[] {
	const declarations: Declaration[] = [];
	for (const chunk of body.split(";")) {
		const colon = chunk.indexOf(":");
		if (colon === -1 || chunk.includes("{")) continue;
		const prop = chunk.slice(0, colon).trim().toLowerCase();
		const value = chunk.slice(colon + 1).trim();
		if (prop !== "" && value !== "") declarations.push({ prop, value });
	}
	return declarations;
}

/** The subject compound of one complex selector — the element the rule
 *  paints (last compound after combinators). */
function subjectCompound(selector: string): string {
	const parts = selector
		.split(/[\s>+~]+/)
		.map((p) => p.trim())
		.filter((p) => p !== "");
	return parts[parts.length - 1] ?? "";
}

function isGuardedSubject(selector: string): boolean {
	const subject = subjectCompound(selector);
	const classes = [...subject.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
	return classes.some((c) => c !== undefined && GUARDED_CLASSES.has(c));
}

/** `0` / `none`, or a value whose paint is transparent (the sanctioned
 *  transparent border track). */
function isFrameless(prop: string, value: string): boolean {
	const v = value.trim().toLowerCase();
	if (v === "0" || v === "none" || v === "initial" || v === "unset") return true;
	if (prop === "box-shadow") return /\btransparent\b/.test(v);
	return /\btransparent\b/.test(v);
}

type Violation = { file: string; selector: string; prop: string; value: string };

function scan(): { violations: Violation[]; guardedRestFrameDecls: number; fileCount: number } {
	const violations: Violation[] = [];
	let guardedRestFrameDecls = 0;
	const files = collectCssFiles(SRC_DIR);
	for (const file of files) {
		const rel = relative(SRC_DIR, file);
		for (const rule of parseRules(readFileSync(file, "utf8"))) {
			const restGuardedSelectors = rule.selector
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s !== "" && !STATE_MARKERS.test(s) && isGuardedSubject(s));
			if (restGuardedSelectors.length === 0) continue;
			for (const { prop, value } of rule.declarations) {
				if (!FRAME_PROPS.has(prop)) continue;
				guardedRestFrameDecls += 1;
				if (isFrameless(prop, value)) continue;
				for (const selector of restGuardedSelectors) {
					if (ALLOWLIST.has(`${selector} :: ${prop}`)) continue;
					violations.push({ file: rel, selector, prop, value });
				}
			}
		}
	}
	return { violations, guardedRestFrameDecls, fileCount: files.length };
}

describe("rest-state frame guard (Files)", () => {
	const result = scan();

	it("finds the app stylesheets", () => {
		// styles.css + ui/storage-panel.css at minimum; if this drops the guard
		// has gone blind (moved files, changed extensions) — fix the scan.
		expect(result.fileCount).toBeGreaterThanOrEqual(2);
	});

	it("still sees the guarded rest-state rules (guard is not vacuous)", () => {
		// Grid + gallery tiles and the sidebar tree row all keep a transparent
		// border TRACK at rest, and the inspector carries its allowlisted
		// overlay shadow — the scan must observe several frame declarations on
		// guarded rest selectors. Zero/near-zero means selectors were renamed
		// without updating GUARDED_CLASSES: the guard would pass forever.
		expect(result.guardedRestFrameDecls).toBeGreaterThanOrEqual(3);
	});

	it("declares no non-transparent border/outline/box-shadow on tiles, rows or containers at rest", () => {
		const report = result.violations
			.map(
				(v) =>
					`${v.file} — \`${v.selector}\` paints \`${v.prop}: ${v.value}\` at rest.\n  Tiles/rows/containers are borderless at rest (f9e55cb): use a transparent\n  border track (\`border: var(--border-width) solid transparent\`) and tint it\n  in the hover/selection state — or add a reviewed ALLOWLIST entry.`,
			)
			.join("\n");
		expect(result.violations, report).toEqual([]);
	});
});

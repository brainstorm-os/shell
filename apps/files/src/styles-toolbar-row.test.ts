/**
 * Toolbar control-row contract — the filter row is ONE baseline, and its
 * free space belongs to the row, not to the left group.
 *
 * The regression this guards (POLISH — Files filter row, 2026-08-10):
 *   • `.toolbar__group--start { flex: 1 1 auto }` grew the left group to the
 *     whole row while its only child `.toolbar__search` was clamped at
 *     `max-width: 360px`. The surplus (~210px at the default 1100×720 window,
 *     minus the 248px sidebar) therefore landed INSIDE the group, where
 *     nothing can paint it, and `justify-content: space-between` on `.toolbar`
 *     went inert. A group that only ever shrinks puts that space back between
 *     the two groups, which is what `space-between` is for.
 *   • the row stood at the lg (40px) control height while every control in it
 *     was the sm (24px) tier, so nothing lined up with anything — the
 *     recurring adjacent-control-heights defect. Contacts (`.contacts-list__
 *     search`) and Mailbox (`.mb-list__search`) run their search row at the
 *     shared 44px panel band with md controls; Files now matches.
 *   • the field was hand-rolled (`.toolbar__search-input` with its own
 *     `--text-size-md` override, no clear ✕) instead of the shared
 *     `<Searchbar className="bs-searchbar--field">`, the SDK variant that
 *     exists precisely for a searchbar sitting in a control row.
 *
 * Same posture as `styles-rest-frames.test.ts` / `styles-lane-fill.test.ts`:
 * a regression here must be a reviewed decision, not a silent one.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(SRC_DIR, "styles.css");
const APP_PATH = join(SRC_DIR, "app.tsx");

/** Every top-level rule body whose selector list contains `selector`.
 *  Comments are stripped first — rule comments in this stylesheet quote CSS
 *  and would confuse the brace scan. */
function ruleBodies(css: string, selector: string): string[] {
	const bodies: string[] = [];
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const re = /([^{}]+)\{([^{}]*)\}/g;
	for (const match of stripped.matchAll(re)) {
		const selectors = (match[1] ?? "").trim();
		if (selectors.split(",").some((s) => s.trim() === selector)) {
			bodies.push(match[2] ?? "");
		}
	}
	return bodies;
}

function onlyBody(css: string, selector: string): string {
	const bodies = ruleBodies(css, selector);
	expect(bodies.length, `expected exactly one rule for \`${selector}\``).toBe(1);
	return bodies[0] ?? "";
}

describe("files toolbar is one control row", () => {
	const css = readFileSync(CSS_PATH, "utf8");
	const tsx = readFileSync(APP_PATH, "utf8");

	it("the start group shrinks but never grows", () => {
		const body = onlyBody(css, ".toolbar__group--start");
		const flex = /flex:\s*([^;]+);/.exec(body)?.[1]?.trim();
		expect(flex, ".toolbar__group--start must declare a flex shorthand").toBeDefined();
		expect(
			flex?.startsWith("0 "),
			`.toolbar__group--start must not grow (flex-grow 0) — got \`${flex}\`; a growing group eats the row's free space while the field inside it is clamped, and that surplus is unpaintable dead space`,
		).toBe(true);
	});

	it("the search field is sized by flex-basis, not clamped by max-width", () => {
		const body = onlyBody(css, ":root .toolbar__search");
		expect(body, ".toolbar__search must not clamp with max-width").not.toMatch(/max-width/);
		expect(body, ".toolbar__search must declare a flex basis").toMatch(/flex:\s*0\s+1\s+\d+px/);
		expect(body, ".toolbar__search must declare a min-width floor").toMatch(/min-width:\s*\d+px/);
	});

	it("the row sits on the shared 44px panel band", () => {
		const body = onlyBody(css, ".toolbar");
		expect(
			body,
			"the toolbar row must sit on the 44px panel band contacts/mailbox use, not the 40px lg control height",
		).toMatch(/height:\s*44px/);
	});

	it("no hand-rolled search field survives in the stylesheet", () => {
		for (const dead of [
			".toolbar__search-input",
			".toolbar__search-glyph",
			".toolbar__search:focus-within",
		]) {
			expect(
				ruleBodies(css, dead).length,
				`\`${dead}\` styles a hand-rolled field the shared <Searchbar> owns`,
			).toBe(0);
		}
	});

	it("the field is the shared control-row searchbar", () => {
		expect(tsx, "Files must import the shared <Searchbar>").toMatch(
			/import \{[^}]*\bSearchbar\b[^}]*\} from "@brainstorm-os\/sdk\/searchbar"/,
		);
		expect(
			tsx,
			"the toolbar search must wear the .bs-searchbar--field control-row variant",
		).toContain("bs-searchbar--field");
	});

	it("every control in the row is on the md tier", () => {
		const toolbar = /<div className="toolbar"[\s\S]*?\n\t{6}<\/div>/.exec(tsx)?.[0];
		expect(toolbar, "could not locate the toolbar JSX block").toBeDefined();
		expect(
			toolbar,
			"the toolbar's controls must not use the sm (24px) tier — the row is md (32px) throughout",
		).not.toMatch(/bs-(select|input|btn)--sm/);
	});
});

describe("files toolbar end group is one face", () => {
	const css = readFileSync(CSS_PATH, "utf8");
	const tsx = readFileSync(APP_PATH, "utf8");
	const filterTsx = readFileSync(join(SRC_DIR, "ui", "filter-bar.tsx"), "utf8");

	it("the Filter toggle wears the same field face as Sort-by and the view picker", () => {
		const className = /className="([^"]*\btoolbar__filter\b[^"]*)"/.exec(filterTsx)?.[1] ?? "";
		expect(className.split(" "), "Filter must wear the shared .bs-select face").toContain(
			"bs-select",
		);
		expect(
			className,
			"a transparent .bs-btn--secondary beside two white fields reads as a disabled control",
		).not.toMatch(/bs-btn/);
	});

	it("the Sort-by trigger shows the dropdown caret, never the sort direction", () => {
		const trigger = /data-testid="toolbar-sort"[\s\S]*?<\/button>/.exec(tsx)?.[0];
		expect(trigger, "could not locate the sort trigger JSX").toBeDefined();
		expect(trigger).toContain("IconName.CaretDown");
		expect(trigger, "an up caret on a closed menu reads as an open one").not.toContain("CaretUp");
	});

	it("the view-options menu is not held to the small panel's 480px cap and shows scroll shadows", () => {
		const panel = onlyBody(css, ".bs-popover__panel:has(.sort-menu__items)");
		expect(panel).toMatch(/max-height:\s*80vh/);
		const body = onlyBody(css, ".bs-popover__body:has(> .sort-menu__items)");
		expect(body, "the covers must scroll with the content").toMatch(/\blocal\b/);
		expect(body, "the edge shadows must stay pinned to the scrollport").toMatch(/\bscroll\b/);
	});
});

describe("files bulk-action bar does not sit on the content", () => {
	const css = readFileSync(CSS_PATH, "utf8");

	it("the bar is an opaque surface", () => {
		const body = onlyBody(css, ".files-bulkbar");
		expect(body).toMatch(/background:\s*var\(--color-background-elevated\)/);
		expect(body, "glass lets the tiles underneath read through the labels").not.toMatch(
			/glass-background|backdrop-filter/,
		);
	});

	it("the list reserves the bar's footprint while the bar is shown", () => {
		const body = onlyBody(css, ".content-list:has(~ .files-bulkbar)");
		expect(body).toMatch(/padding-bottom:/);
	});
});

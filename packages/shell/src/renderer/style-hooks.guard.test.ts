import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STYLE_HOOK_REGIONS } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";

/**
 * Structural guard for the frozen `data-bs-region` hook contract (OQ-183).
 * The contract (`@brainstorm-os/sdk-types` `STYLE_HOOK_REGIONS`) promises a
 * stable chrome anchor for every listed region; this asserts each one is
 * actually stamped in the rendered chrome — so a refactor can't silently
 * drop a hook published StylePacks target — and that no undocumented region
 * is stamped (additions go through the contract).
 *
 * Two stamp forms are scanned: the shell renderer JSX
 * (`data-bs-region="<region>"`) and the app-preload app-frame stamper
 * (`[".app-header…", "<region>"]` tuples, stamped via setAttribute).
 */
const here = fileURLToPath(new URL(".", import.meta.url));

// Source files that carry hooks (renderer chrome + the preload app-frame
// stamper). Relative to this test's directory (packages/shell/src/renderer).
const SOURCES = [
	"dashboard.tsx",
	"settings/settings.tsx",
	"ui/popover.tsx",
	"lock-screen.tsx",
	"../preload/app-preload.ts",
];

function collectStampedRegions(): Set<string> {
	const found = new Set<string>();
	const jsxAttr = /data-bs-region="([a-z-]+)"/g;
	const preloadTuple = /\[\s*"\.[^"]+",\s*"([a-z-]+)"\s*\]/g;
	for (const rel of SOURCES) {
		const src = readFileSync(`${here}${rel}`, "utf8");
		for (const m of src.matchAll(jsxAttr)) found.add(m[1] as string);
		for (const m of src.matchAll(preloadTuple)) found.add(m[1] as string);
	}
	return found;
}

describe("data-bs-region hook contract", () => {
	const stamped = collectStampedRegions();

	it("stamps every region the contract promises", () => {
		const missing = STYLE_HOOK_REGIONS.filter((r) => !stamped.has(r));
		expect(missing).toEqual([]);
	});

	it("stamps no region outside the frozen vocabulary", () => {
		const contract = new Set<string>(STYLE_HOOK_REGIONS);
		const undocumented = [...stamped].filter((r) => !contract.has(r));
		expect(undocumented).toEqual([]);
	});
});

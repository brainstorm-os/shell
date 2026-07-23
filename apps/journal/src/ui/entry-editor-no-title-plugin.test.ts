/**
 * F-455 — Journal must NOT mount TitlePlugin. The plugin injects an empty
 * TitleNode as root[0], which makes Lexical \`$canShowPlaceholder\` false and
 * suppresses the writeHint on a fresh day. TitleNode stays registered for
 * Notes-seeded bodies; we just skip the invariant enforcement.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "entry-editor.tsx"),
	"utf8",
);

describe("JournalEntryEditor — no TitlePlugin (F-455)", () => {
	it("does not import or mount TitlePlugin", () => {
		expect(SOURCE).not.toMatch(/\bTitlePlugin\b/);
		// TitleNode stays so Notes-seeded journal bodies still parse.
		expect(SOURCE).toMatch(/\bTitleNode\b/);
	});

	it("still passes a placeholder through for empty days", () => {
		// The island → editor prop chain carries writeHint; guard the leaf.
		expect(SOURCE).toMatch(/placeholder\?:\s*string/);
		expect(SOURCE).toMatch(/\.\.\.\(placeholder \? \{ placeholder \} : \{\}\)/);
	});
});

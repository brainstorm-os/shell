import { describe, expect, it } from "vitest";
import { _defaultsForTesting, t } from "../src/i18n";

describe("t() (shared @brainstorm-os/sdk/i18n createT)", () => {
	it("returns the default-English string for known ids", () => {
		expect(t("brainstorm.files.app.title")).toBe("Files");
		expect(t("brainstorm.files.actions.new")).toBe("New");
	});

	it("substitutes named params", () => {
		expect(t("brainstorm.files.bulk.renameTitle", { n: 42 })).toBe("Rename 42 items");
		expect(t("brainstorm.files.collision.body", { name: "draft.md", folder: "Inbox" })).toBe(
			"A folder or file named “draft.md” already exists in “Inbox”. What would you like to do?",
		);
	});

	it("leaves placeholders intact when a param is missing", () => {
		expect(t("brainstorm.files.bulk.renameTitle")).toBe("Rename {n} items");
		expect(t("brainstorm.files.bulk.renameTitle", {})).toBe("Rename {n} items");
	});

	it("degrades an unknown key to the key string (createT contract)", () => {
		// `createT` returns the key itself for an unrecognised id (so a
		// missing translation is visible, never a crash). The old app-local
		// `t()` returned a `[?id]` marker + console.warn; that helper is
		// retired in favour of the shared B-2 surface.
		expect(t("brainstorm.files.does.not.exist" as never)).toBe("brainstorm.files.does.not.exist");
	});

	it("namespaces every default under brainstorm.files.*", () => {
		const keys = Object.keys(_defaultsForTesting());
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) {
			expect(key.startsWith("brainstorm.files.")).toBe(true);
		}
	});
});

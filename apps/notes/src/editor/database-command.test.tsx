/**
 * 9.12.12 — the `/database` slash command: present in the block-command
 * catalogue (Embed category, list/table keywords) and the embed-picker
 * store round-trips the `typeFilter` scope it opens with.
 */

import { COLLECTION_TYPE_URL } from "@brainstorm-os/sdk-types";
import { afterEach, describe, expect, it } from "vitest";
import { BLOCK_COMMANDS, CommandCategory } from "./commands";
import { embedPickerStore } from "./embed-picker-store";

afterEach(() => {
	embedPickerStore.close();
});

describe("/database slash command", () => {
	it("is in the catalogue as an Embed command reachable by database/list/table", () => {
		const cmd = BLOCK_COMMANDS.find((c) => c.id === "block.embed.database");
		expect(cmd).toBeDefined();
		expect(cmd?.category).toBe(CommandCategory.Embed);
		for (const kw of ["database", "list", "table"]) {
			expect(cmd?.keywords).toContain(kw);
		}
	});

	it("embedPickerStore round-trips the typeFilter scope", () => {
		embedPickerStore.open({
			paragraphKey: "p1",
			anchor: { top: 0, left: 0, bottom: 20 },
			typeFilter: COLLECTION_TYPE_URL,
		});
		expect(embedPickerStore.getSnapshot()?.typeFilter).toBe(COLLECTION_TYPE_URL);
	});

	it("a plain /embed open carries no typeFilter (unscoped picker)", () => {
		embedPickerStore.open({
			paragraphKey: "p1",
			anchor: { top: 0, left: 0, bottom: 20 },
		});
		expect(embedPickerStore.getSnapshot()?.typeFilter).toBeUndefined();
	});
});

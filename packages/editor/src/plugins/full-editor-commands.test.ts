/**
 * F-405 — slash-menu parity between Notes and the other full-editor hosts.
 *
 * The report: Journal / Tasks advertise "Type '/' for commands" but the menu
 * was block-types only — `/emb` matched nothing and fell through as literal
 * text, so the embed nodes that shipped had no path a user could type.
 *
 * Since then every full-editor host routes through `FullEditorPlugins` →
 * `StandardEditingPlugins` → the same `SlashMenuPlugin` Notes uses, and the
 * Embed / Reference commands are appended whenever the host supplies a
 * `currentEntityId`. These tests pin that: the catalogue a host offers is a
 * pure function of its flags, so parity is asserted without mounting Lexical.
 */

import { describe, expect, it } from "vitest";
import { type BlockCommand, CommandCategory } from "../block-command";
import type { EditorT } from "../i18n";
import { fullEditorExtraCommands } from "./full-editor-plugins";
import { filterCommands } from "./slash-menu-plugin";

// The catalogue only ever uses `t` for display strings; echoing the key back
// keeps the assertions readable and independent of the English catalogue.
const t = ((key: string) => key) as unknown as EditorT;

const labels = (cmds: readonly BlockCommand[]) => cmds.map((c) => c.id);

describe("full-editor slash catalogue (F-405 parity)", () => {
	it("offers Embed and Reference once the host supplies an entity context", () => {
		const cmds = fullEditorExtraCommands(t, { entityEmbed: true, transclusion: true });
		const ids = labels(cmds);
		// Both embed affordances are reachable from `/` — the wall the report hit.
		expect(ids).toContain("block.embed.entity");
		expect(ids).toContain("block.transclusion");
		// Order mirrors Notes' catalogue: Embed before Reference.
		expect(ids.indexOf("block.embed.entity")).toBeLessThan(ids.indexOf("block.transclusion"));
	});

	it("withholds them when the host has no entity to embed into", () => {
		// Not a regression: both commands need something to embed *into*, so a
		// host without `currentEntityId` correctly doesn't advertise them.
		const ids = labels(fullEditorExtraCommands(t, { entityEmbed: false, transclusion: false }));
		expect(ids).not.toContain("block.embed.entity");
		expect(ids).not.toContain("block.transclusion");
	});

	it("matches the typed query `/emb` to the Embed command", () => {
		// The literal reproduction of the report: typing `/emb` must surface a
		// row rather than dismissing the menu and leaving text behind.
		const cmds = fullEditorExtraCommands(t, { entityEmbed: true, transclusion: true });
		const hits = filterCommands(cmds, "emb");
		expect(hits.length).toBeGreaterThan(0);
		expect(labels(hits)).toContain("block.embed.entity");
	});

	it("keeps host-supplied commands ahead of the shared embed pair", () => {
		const own: BlockCommand[] = [
			{
				id: "host-thing",
				category: CommandCategory.Basic,
				label: "Host thing",
				icon: null,
				keywords: [],
				run: () => undefined,
			},
		];
		const ids = labels(
			fullEditorExtraCommands(t, { extraCommands: own, entityEmbed: true, transclusion: true }),
		);
		expect(ids[0]).toBe("host-thing");
	});
});

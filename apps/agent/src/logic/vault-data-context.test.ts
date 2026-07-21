import { COLLECTION_TYPE_URL } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { type VaultDataEntity, buildVaultDataContextBlock } from "./vault-data-context";

const note = (i: number): VaultDataEntity => ({
	type: "brainstorm/Note/v1",
	properties: { title: `n${i}` },
});
const task = (i: number): VaultDataEntity => ({
	type: "brainstorm/Task/v1",
	properties: { title: `t${i}` },
});
const collection = (name: unknown): VaultDataEntity => ({
	type: COLLECTION_TYPE_URL,
	properties: { name },
});

describe("buildVaultDataContextBlock (doc 63 — vault data context)", () => {
	it("tallies objects by friendly type name, most-common first", () => {
		const entities = [note(1), note(2), note(3), task(1)];
		const block = buildVaultDataContextBlock(entities);
		expect(block).toContain("## Your vault");
		expect(block).toContain("Your vault contains 3 Notes, 1 Tasks.");
	});

	it("lists collections by name", () => {
		const block = buildVaultDataContextBlock([
			note(1),
			collection("Projects"),
			collection("Reading list"),
		]);
		expect(block).toContain("Collections: Projects, Reading list.");
	});

	it("excludes the agent's own bookkeeping types from the tally", () => {
		const entities = [
			note(1),
			{ type: "brainstorm/Conversation/v1", properties: {} },
			{ type: "brainstorm/Message/v1", properties: {} },
		];
		const block = buildVaultDataContextBlock(
			entities,
			new Set(["brainstorm/Conversation/v1", "brainstorm/Message/v1"]),
		);
		expect(block).toContain("1 Notes");
		expect(block).not.toContain("Conversation");
		expect(block).not.toContain("Message");
	});

	it("returns empty when there is nothing to report", () => {
		expect(buildVaultDataContextBlock([])).toBe("");
		expect(
			buildVaultDataContextBlock(
				[{ type: "brainstorm/Conversation/v1", properties: {} }],
				new Set(["brainstorm/Conversation/v1"]),
			),
		).toBe("");
	});

	it("collapses the tail of a long type list", () => {
		const entities = Array.from({ length: 15 }, (_, i) => ({
			type: `brainstorm/Type${i}/v1`,
			properties: {},
		}));
		const block = buildVaultDataContextBlock(entities);
		expect(block).toContain("and 3 more types");
	});

	it("clamps + control-strips collection names; skips empty/non-string", () => {
		const block = buildVaultDataContextBlock([
			collection("a\nb\tc"),
			collection("   "),
			collection(42),
			collection("X".repeat(200)),
		]);
		expect(block).toContain("a b c");
		expect(block).not.toContain("   ,");
		const collectionsLine = block.split("\n").find((l) => l.startsWith("Collections:")) ?? "";
		expect(collectionsLine).toContain("…");
	});
});

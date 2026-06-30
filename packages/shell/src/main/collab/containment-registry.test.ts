/**
 * Containment registry (Collab-C5 — collection sharing, design 71).
 *
 * Two halves: the pure lookups + source-builder, and an integration half that
 * runs the registry's `childrenSourceFor` through the REAL `queryVaultListSource`
 * against a REAL `entities.db` — the same path `SharingEngine` will use to
 * enumerate a container's children for the cascade. The integration half is the
 * one that matters: it proves the design's keystone claim that the built
 * membership engine enumerates a collection's children with no app migration.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ListSource, MESSAGE_TYPE_URL } from "@brainstorm/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryVaultListSource } from "../entities/vault-entities-service";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import {
	type ContainmentRule,
	childrenSourceFor,
	containmentRuleForChild,
	containmentRuleForParent,
} from "./containment-registry";

const CHANNEL_TYPE = "io.brainstorm.chat/Channel/v1";
const PROJECT_TYPE = "brainstorm/Project/v1";
const TASK_TYPE = "brainstorm/Task/v1";
const WHITEBOARD_TYPE = "brainstorm/Whiteboard/v1";
const WHITEBOARD_EDGE_TYPE = "brainstorm/WhiteboardEdge/v1";
const NOTE_TYPE = "brainstorm/Note/v1";

describe("containment registry — lookups", () => {
	it("maps a chat Channel to its Message children", () => {
		const rule = containmentRuleForParent(CHANNEL_TYPE);
		expect(rule).not.toBeNull();
		expect(rule?.childType).toBe(MESSAGE_TYPE_URL);
		expect(rule?.childParentProp).toBe("conversation");
	});

	it("maps a Project to its Task children", () => {
		const rule = containmentRuleForParent(PROJECT_TYPE);
		expect(rule?.childType).toBe(TASK_TYPE);
		expect(rule?.childParentProp).toBe("io.brainstorm.tasks/project");
	});

	it("maps a Whiteboard to its edge children (non-dotted FK)", () => {
		const rule = containmentRuleForParent(WHITEBOARD_TYPE);
		expect(rule?.childType).toBe(WHITEBOARD_EDGE_TYPE);
		expect(rule?.childParentProp).toBe("whiteboardId");
	});

	it("resolves rules by child type too", () => {
		expect(containmentRuleForChild(MESSAGE_TYPE_URL)?.parentType).toBe(CHANNEL_TYPE);
		expect(containmentRuleForChild(TASK_TYPE)?.parentType).toBe(PROJECT_TYPE);
		expect(containmentRuleForChild(WHITEBOARD_EDGE_TYPE)?.parentType).toBe(WHITEBOARD_TYPE);
	});

	it("returns null for single-entity / unknown types (no cascade)", () => {
		expect(containmentRuleForParent(NOTE_TYPE)).toBeNull();
		expect(containmentRuleForChild(NOTE_TYPE)).toBeNull();
		expect(containmentRuleForParent("io.x/Unknown/v1")).toBeNull();
		expect(containmentRuleForChild("io.x/Unknown/v1")).toBeNull();
	});
});

describe("containment registry — childrenSourceFor over a real entities.db", () => {
	let vaultDir = "";
	let stores: DataStores;
	let repo: EntitiesRepository;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-containment-"));
		stores = new DataStores(vaultDir);
		const db = await stores.open("entities");
		repo = new EntitiesRepository(db);
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	const getRepo = async () => repo;

	function seed(id: string, type: string, properties: Record<string, unknown> = {}): void {
		repo.create({ id, type, properties, createdBy: "io.x", now: 10, dekId: null });
	}

	async function resolve(source: ListSource): Promise<string[]> {
		const result = await queryVaultListSource(source, getRepo);
		if (!result.ok) throw new Error(`expected ok, got ${result.error.kind}: ${result.error.message}`);
		return result.ids;
	}

	it("enumerates exactly a channel's messages — not other channels', not non-messages", async () => {
		const rule = containmentRuleForParent(CHANNEL_TYPE) as ContainmentRule;
		seed("c1", CHANNEL_TYPE, { name: "general" });
		seed("c2", CHANNEL_TYPE, { name: "random" });
		seed("m1", MESSAGE_TYPE_URL, { conversation: "c1", body: "hi" });
		seed("m2", MESSAGE_TYPE_URL, { conversation: "c1", body: "again" });
		seed("m3", MESSAGE_TYPE_URL, { conversation: "c2", body: "elsewhere" });
		seed("n1", NOTE_TYPE, { conversation: "c1" }); // a non-message that happens to carry the prop

		expect(await resolve(childrenSourceFor(rule, "c1"))).toEqual(["m1", "m2"]);
		expect(await resolve(childrenSourceFor(rule, "c2"))).toEqual(["m3"]);
	});

	// M2 (Tasks) gap, recorded honestly: the task→project key
	// `io.brainstorm.tasks/project` contains dots, and `byFilter`'s path
	// evaluator splits on the first dot (`readPropertyPath`, in-memory-entities.ts),
	// so `$eq: { "io.brainstorm.tasks/project": id }` reads a nested `properties.io.…`
	// (undefined) rather than the flat key. Chat's `conversation` (no dots) is
	// unaffected — M1 works today. Resolution for M2 (design 71 §Calendar/perf):
	// persist a containment link edge at the create chokepoint and enumerate via
	// `byLink` over the SQL reverse index — which also removes the byFilter
	// full-vault scan the review flagged. Until then, dotted child-parent keys
	// do not resolve via childrenSourceFor.
	it.todo(
		"enumerates a project's tasks — pending M2: dotted key needs byLink over a persisted containment edge",
	);

	it("enumerates a whiteboard's edges by its non-dotted whiteboardId FK", async () => {
		const rule = containmentRuleForParent(WHITEBOARD_TYPE) as ContainmentRule;
		seed("wb1", WHITEBOARD_TYPE, { name: "Roadmap" });
		seed("e1", WHITEBOARD_EDGE_TYPE, { whiteboardId: "wb1" });
		seed("e2", WHITEBOARD_EDGE_TYPE, { whiteboardId: "wb1" });
		seed("e3", WHITEBOARD_EDGE_TYPE, { whiteboardId: "other" });
		expect(await resolve(childrenSourceFor(rule, "wb1"))).toEqual(["e1", "e2"]);
	});

	it("returns empty for a container with no children yet (empty channel)", async () => {
		const rule = containmentRuleForParent(CHANNEL_TYPE) as ContainmentRule;
		seed("c1", CHANNEL_TYPE, { name: "empty" });
		expect(await resolve(childrenSourceFor(rule, "c1"))).toEqual([]);
	});
});

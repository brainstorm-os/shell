import { LIST_ENTITY_TYPE, entityToList } from "@brainstorm-os/sdk";
import type { Entity } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	TEMPLATE_CREATED_BY,
	TemplateImportOutcome,
	importTemplate,
	templateCollectionId,
} from "./seed-template";
import { buildTemplateManifest } from "./template-codec";
import type { WelcomeSeedEntitySpec } from "./welcome-seed";

const NOW = 1_700_000_000_000;
const body = { root: { type: "root", children: [] } } as never;

function manifest() {
	return buildTemplateManifest({
		id: "study",
		name: "Study",
		description: "For students",
		entities: [
			{ id: "s_task", type: "brainstorm/Task/v1", properties: { name: "Read ch.1" } },
			{ id: "s_note", type: "io.brainstorm.notes/Note/v1", properties: { title: "Notes" }, body },
		],
	});
}

/** In-memory deps mirroring `welcome-seed.test`'s fakes. */
function fakeDeps(over: Partial<Record<string, unknown>> = {}) {
	const store = new Map<string, WelcomeSeedEntitySpec>();
	const planted: string[] = [];
	let version = 0;
	const deps = {
		store,
		planted,
		createEntity: (spec: WelcomeSeedEntitySpec) => {
			store.set(spec.id, spec);
		},
		plantBody: (id: string) => {
			planted.push(id);
		},
		readVersion: () => version,
		writeVersion: (v: number) => {
			version = v;
		},
		now: NOW,
		...over,
	};
	return deps;
}

/** Reconstruct the parent Collection `List` from what `createEntity` stored. */
function collectionFrom(store: Map<string, WelcomeSeedEntitySpec>, id: string) {
	const spec = store.get(id);
	if (!spec) return null;
	const entity: Entity = {
		id: spec.id,
		type: spec.type,
		properties: spec.properties,
		createdBy: spec.createdBy,
		createdAt: NOW,
		updatedAt: NOW,
	};
	return entityToList(entity);
}

describe("importTemplate", () => {
	it("creates every entity + the parent Collection and plants note bodies", async () => {
		const deps = fakeDeps();
		const result = await importTemplate(manifest(), deps);

		expect(result.outcome).toBe(TemplateImportOutcome.Imported);
		expect(result.created).toBe(3); // 2 entities + 1 Collection
		expect(result.planted).toBe(1); // only the note has a body
		expect(result.errors).toEqual([]);
		expect(deps.planted).toEqual(["s_note"]);
		expect(deps.store.get("s_task")?.createdBy).toBe(TEMPLATE_CREATED_BY);
	});

	it("makes the parent Collection a manual List/v1 with every entity as a member", async () => {
		const deps = fakeDeps();
		const result = await importTemplate(manifest(), deps);

		const cid = templateCollectionId("study");
		expect(result.collectionId).toBe(cid);
		const list = collectionFrom(deps.store, cid);
		expect(deps.store.get(cid)?.type).toBe(LIST_ENTITY_TYPE);
		expect(list?.name).toBe("Study");
		expect(list?.source).toBeNull(); // manual collection
		expect(list?.members.include.map((m) => m.entityId).sort()).toEqual(["s_note", "s_task"]);
	});

	it("is idempotent — a second import is a no-op once stamped", async () => {
		const deps = fakeDeps();
		await importTemplate(manifest(), deps);
		const sizeAfterFirst = deps.store.size;

		const second = await importTemplate(manifest(), deps);
		expect(second.outcome).toBe(TemplateImportOutcome.AlreadyImported);
		expect(second.created).toBe(0);
		expect(deps.store.size).toBe(sizeAfterFirst); // no duplicate rows
	});

	it("isolates a per-entity create failure (others + the Collection still land)", async () => {
		const store = new Map<string, WelcomeSeedEntitySpec>();
		let version = 0;
		const createEntity = vi.fn((spec: WelcomeSeedEntitySpec) => {
			if (spec.id === "s_task") throw new Error("boom");
			store.set(spec.id, spec);
		});
		const result = await importTemplate(manifest(), {
			store,
			createEntity,
			plantBody: () => {},
			readVersion: () => version,
			writeVersion: (v: number) => {
				version = v;
			},
			now: NOW,
		} as never);

		expect(result.errors.some((e) => e.startsWith("s_task:"))).toBe(true);
		expect(store.has("s_note")).toBe(true);
		expect(store.has(templateCollectionId("study"))).toBe(true); // Collection still created
	});
});

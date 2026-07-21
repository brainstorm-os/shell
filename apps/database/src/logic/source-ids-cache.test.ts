/**
 * Tests for the 9.12.3 app-half: the shell-resolved source-id cache the
 * render path consults synchronously, filled by `vaultEntities.querySource`.
 * Truth table: fingerprint-gated lookup, error → local fallback, refresh
 * change signal, last-writer-wins generations, and the
 * `compileMembershipWith` override layering on top of shell ids.
 */

import type { List, ListSource, SourceQueryResult } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { ListSourceKind } from "../types/list-source";
import type { EntityRow, InMemoryEntities } from "./in-memory-entities";
import {
	type SourceQueryService,
	compileMembershipWith,
	createSourceIdsCache,
	sourceFingerprint,
} from "./source-ids-cache";

const NOW = 1_700_000_000_000;

function entity(id: string, type: string, properties: Record<string, unknown> = {}): EntityRow {
	return { id, type, properties, createdAt: 0, updatedAt: 0, deletedAt: null };
}

function makeList(partial: Partial<List> & { id: string; name: string }): List {
	return {
		icon: null,
		description: "",
		source: null,
		members: { include: [], exclude: [] },
		views: [],
		defaultViewId: null,
		defaultTemplate: null,
		createdAt: 0,
		updatedAt: 0,
		...partial,
	};
}

const TASK_SOURCE: ListSource = { kind: ListSourceKind.ByType, types: ["io.test/Task/v1"] };

const DB: InMemoryEntities = {
	entities: [
		entity("a", "io.test/Task/v1", { status: "Done" }),
		entity("b", "io.test/Task/v1", { status: "Open" }),
		entity("c", "io.test/Note/v1", {}),
	],
	links: [],
};

function okService(ids: string[]): SourceQueryService {
	return { querySource: async () => ({ ok: true, ids }) };
}

function failService(kind: "source-invalid" | "source-too-expensive"): SourceQueryService {
	return {
		querySource: async (): Promise<SourceQueryResult> => ({
			ok: false,
			error: { kind, message: "rejected" },
		}),
	};
}

describe("createSourceIdsCache", () => {
	it("lookup is null before any refresh (caller falls back to local eval)", () => {
		const cache = createSourceIdsCache();
		const list = makeList({ id: "L1", name: "Tasks", source: TASK_SOURCE });
		expect(cache.lookup(list)).toBeNull();
	});

	it("refresh resolves sourced lists and lookup serves the shell ids", async () => {
		const cache = createSourceIdsCache();
		const list = makeList({ id: "L1", name: "Tasks", source: TASK_SOURCE });
		const changed = await cache.refresh([list], okService(["a", "b"]));
		expect(changed).toBe(true);
		expect(Array.from(cache.lookup(list) ?? []).sort()).toEqual(["a", "b"]);
	});

	it("a source-less list is never resolved nor looked up", async () => {
		const cache = createSourceIdsCache();
		const manual = makeList({ id: "L2", name: "Manual" });
		let calls = 0;
		const svc: SourceQueryService = {
			querySource: async () => {
				calls += 1;
				return { ok: true, ids: [] };
			},
		};
		await cache.refresh([manual], svc);
		expect(calls).toBe(0);
		expect(cache.lookup(manual)).toBeNull();
	});

	it("editing the source invalidates the entry via the fingerprint", async () => {
		const cache = createSourceIdsCache();
		const list = makeList({ id: "L1", name: "Tasks", source: TASK_SOURCE });
		await cache.refresh([list], okService(["a"]));
		const edited: List = {
			...list,
			source: { kind: ListSourceKind.ByType, types: ["io.test/Note/v1"] },
		};
		expect(cache.lookup(edited)).toBeNull();
		expect(cache.lookup(list)).not.toBeNull();
	});

	it("a rejected source drops the entry (fall back to local eval)", async () => {
		const cache = createSourceIdsCache();
		const list = makeList({ id: "L1", name: "Tasks", source: TASK_SOURCE });
		await cache.refresh([list], okService(["a"]));
		const changed = await cache.refresh([list], failService("source-too-expensive"));
		expect(changed).toBe(true);
		expect(cache.lookup(list)).toBeNull();
	});

	it("a throwing service drops the entry and never rejects the refresh", async () => {
		const cache = createSourceIdsCache();
		const list = makeList({ id: "L1", name: "Tasks", source: TASK_SOURCE });
		await cache.refresh([list], okService(["a"]));
		const svc: SourceQueryService = {
			querySource: async () => {
				throw new Error("bridge down");
			},
		};
		await expect(cache.refresh([list], svc)).resolves.toBe(true);
		expect(cache.lookup(list)).toBeNull();
	});

	it("an unchanged result reports changed=false (no re-render churn)", async () => {
		const cache = createSourceIdsCache();
		const list = makeList({ id: "L1", name: "Tasks", source: TASK_SOURCE });
		await cache.refresh([list], okService(["a", "b"]));
		const changed = await cache.refresh([list], okService(["b", "a"]));
		expect(changed).toBe(false);
	});

	it("a changed id set reports changed=true", async () => {
		const cache = createSourceIdsCache();
		const list = makeList({ id: "L1", name: "Tasks", source: TASK_SOURCE });
		await cache.refresh([list], okService(["a"]));
		const changed = await cache.refresh([list], okService(["a", "b"]));
		expect(changed).toBe(true);
	});

	it("a list dropped from the set evicts its entry", async () => {
		const cache = createSourceIdsCache();
		const list = makeList({ id: "L1", name: "Tasks", source: TASK_SOURCE });
		await cache.refresh([list], okService(["a"]));
		const changed = await cache.refresh([], okService([]));
		expect(changed).toBe(true);
		expect(cache.lookup(list)).toBeNull();
	});

	it("a slow older refresh never clobbers a newer one (last-writer-wins)", async () => {
		const cache = createSourceIdsCache();
		const list = makeList({ id: "L1", name: "Tasks", source: TASK_SOURCE });
		let releaseOld: (() => void) | undefined;
		const oldSvc: SourceQueryService = {
			querySource: () =>
				new Promise<SourceQueryResult>((resolve) => {
					releaseOld = () => resolve({ ok: true, ids: ["stale"] });
				}),
		};
		const oldRefresh = cache.refresh([list], oldSvc);
		await cache.refresh([list], okService(["fresh"]));
		releaseOld?.();
		await expect(oldRefresh).resolves.toBe(false);
		expect(Array.from(cache.lookup(list) ?? [])).toEqual(["fresh"]);
	});

	it("clear empties every entry", async () => {
		const cache = createSourceIdsCache();
		const list = makeList({ id: "L1", name: "Tasks", source: TASK_SOURCE });
		await cache.refresh([list], okService(["a"]));
		cache.clear();
		expect(cache.lookup(list)).toBeNull();
	});
});

describe("compileMembershipWith", () => {
	it("uses the shell ids when provided, skipping local source evaluation", () => {
		const list = makeList({ id: "L1", name: "Tasks", source: TASK_SOURCE });
		const effective = compileMembershipWith(list, DB, new Set(["c"]));
		expect(Array.from(effective)).toEqual(["c"]);
	});

	it("falls back to local evaluateSource when shell ids are null", () => {
		const list = makeList({ id: "L1", name: "Tasks", source: TASK_SOURCE });
		const effective = compileMembershipWith(list, DB, null);
		expect(Array.from(effective).sort()).toEqual(["a", "b"]);
	});

	it("layers include/exclude overrides on top of shell ids", () => {
		const list = makeList({
			id: "L1",
			name: "Tasks",
			source: TASK_SOURCE,
			members: {
				include: [{ entityId: "c", addedAt: NOW, by: "user" }],
				exclude: [{ entityId: "a", removedAt: NOW, by: "user" }],
			},
		});
		const effective = compileMembershipWith(list, DB, new Set(["a", "b"]));
		expect(Array.from(effective).sort()).toEqual(["b", "c"]);
	});
});

describe("sourceFingerprint", () => {
	it("is stable for identical sources and distinct for different ones", () => {
		expect(sourceFingerprint(TASK_SOURCE)).toBe(
			sourceFingerprint({ kind: ListSourceKind.ByType, types: ["io.test/Task/v1"] }),
		);
		expect(sourceFingerprint(TASK_SOURCE)).not.toBe(
			sourceFingerprint({ kind: ListSourceKind.ByType, types: ["io.test/Note/v1"] }),
		);
	});
});

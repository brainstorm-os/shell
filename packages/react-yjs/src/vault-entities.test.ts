import { describe, expect, it, vi } from "vitest";
import type { Subscription, VaultEntitiesSnapshot, VaultEntity } from "./brainstorm-types";
import {
	createVaultEntitiesStore,
	createVaultListStore,
	vaultSnapshotEquals,
} from "./vault-entities";

function entity(id: string, updatedAt: number): VaultEntity {
	return {
		id,
		type: "io.brainstorm.note/Note/v1",
		properties: {},
		createdAt: 0,
		updatedAt,
		deletedAt: null,
		ownerAppId: "notes",
	};
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Fake service whose `onChange` listeners the test can fire, with a
 *  mutable backing snapshot. */
function fakeService(initial: VaultEntity[]) {
	let entities = initial;
	const listeners = new Set<() => void>();
	const service = {
		list: (): Promise<VaultEntitiesSnapshot> => Promise.resolve({ entities, links: [] }),
		queryPattern: () => Promise.resolve({ ok: true as const, snapshot: { entities, links: [] } }),
		querySource: () => Promise.resolve({ ok: true as const, ids: [] as string[] }),
		onChange: (listener: () => void): Subscription => {
			listeners.add(listener);
			return { unsubscribe: () => listeners.delete(listener) };
		},
	};
	const fire = (next: VaultEntity[]): void => {
		entities = next;
		for (const l of [...listeners]) l();
	};
	return { service, fire, listenerCount: () => listeners.size };
}

describe("vaultSnapshotEquals", () => {
	const snap = (es: VaultEntity[]): VaultEntitiesSnapshot => ({ entities: es, links: [] });

	it("is true for same ids + versions regardless of array identity/order", () => {
		expect(
			vaultSnapshotEquals(
				snap([entity("a", 1), entity("b", 2)]),
				snap([entity("b", 2), entity("a", 1)]),
			),
		).toBe(true);
	});
	it("is false when an entity's updatedAt advanced", () => {
		expect(vaultSnapshotEquals(snap([entity("a", 1)]), snap([entity("a", 2)]))).toBe(false);
	});
	it("is false when an entity is added or removed", () => {
		expect(vaultSnapshotEquals(snap([entity("a", 1)]), snap([entity("a", 1), entity("b", 1)]))).toBe(
			false,
		);
	});
	it("is false when an entity is soft-deleted", () => {
		const deleted = { ...entity("a", 1), deletedAt: 99 };
		expect(vaultSnapshotEquals(snap([entity("a", 1)]), snap([deleted]))).toBe(false);
	});
});

describe("createVaultListStore", () => {
	it("loads via the custom loader and reloads on the service's onChange", async () => {
		const { service, fire } = fakeService([entity("a", 1)]);
		// A repo-style loader keyed off the same coarse signal (the bookmarks shape).
		let calls = 0;
		const store = createVaultListStore<number>({
			service,
			coalesceMs: 0,
			load: () => {
				calls++;
				return Promise.resolve(calls);
			},
			initial: 0,
		});
		const seen: number[] = [];
		store.subscribe(() => seen.push(store.getSnapshot()));
		await flush();
		expect(store.getSnapshot()).toBe(1); // initial load on first subscribe

		fire([entity("a", 1), entity("b", 1)]);
		await flush();
		expect(store.getSnapshot()).toBe(2); // reloaded via onChange
		store.dispose();
	});

	it("unsubscribes from the service when disposed", async () => {
		const { service, listenerCount } = fakeService([entity("a", 1)]);
		const store = createVaultListStore<number>({
			service,
			load: () => Promise.resolve(1),
			initial: 0,
		});
		const off = store.subscribe(() => {});
		await flush();
		expect(listenerCount()).toBe(1);
		off();
		expect(listenerCount()).toBe(0);
		store.dispose();
	});

	it("loads once and never invalidates when the service is null", async () => {
		let calls = 0;
		const store = createVaultListStore<number>({
			service: null,
			load: () => {
				calls++;
				return Promise.resolve(calls);
			},
			initial: 0,
		});
		store.subscribe(() => {});
		await flush();
		expect(calls).toBe(1);
		store.dispose();
	});
});

describe("createVaultEntitiesStore", () => {
	it("exposes the live snapshot and short-circuits an unchanged slice", async () => {
		const { service, fire } = fakeService([entity("a", 5)]);
		const store = createVaultEntitiesStore(service, { coalesceMs: 0 });
		const notifies: number[] = [];
		store.subscribe(() => notifies.push(store.getSnapshot().entities.length));
		await flush();
		expect(store.getSnapshot().entities.map((e) => e.id)).toEqual(["a"]);
		const afterLoad = notifies.length;

		fire([entity("a", 5)]); // same id + version → vaultSnapshotEquals short-circuits
		await flush();
		expect(notifies.length).toBe(afterLoad);

		fire([entity("a", 6)]); // version advanced → notifies
		await flush();
		expect(notifies.length).toBeGreaterThan(afterLoad);
		store.dispose();
	});

	it("yields the empty snapshot for a null service", () => {
		const store = createVaultEntitiesStore(null);
		expect(store.getSnapshot()).toEqual({ entities: [], links: [] });
		store.dispose();
	});
});

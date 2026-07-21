import type { Subscription, VaultEntitiesSnapshot, VaultEntity } from "@brainstorm-os/sdk-types";
// @vitest-environment jsdom
import { type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLiveEntities, useVaultEntities } from "./query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function render(node: ReactNode): Promise<void> {
	await act(async () => {
		root.render(node);
	});
	// Let the store's initial load + the resulting commit settle.
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
}

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

/** A minimal fake `VaultEntitiesService` whose `onChange` listeners can be
 *  fired by the test, and whose `list()` returns the current backing array. */
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
	const setEntities = (next: VaultEntity[]): void => {
		entities = next;
		for (const l of [...listeners]) l();
	};
	return { service, setEntities, listenerCount: () => listeners.size };
}

describe("useVaultEntities", () => {
	it("renders the initial empty snapshot, then the loaded entities", async () => {
		const { service } = fakeService([entity("a", 1)]);
		const captured: { snap?: VaultEntitiesSnapshot } = {};
		function Probe(): ReactNode {
			captured.snap = useVaultEntities(service, { coalesceMs: 0 });
			return null;
		}
		await render(<Probe />);
		expect(captured.snap?.entities.map((e) => e.id)).toEqual(["a"]);
	});

	it("re-renders when the coarse onChange signal reflects a real change", async () => {
		const { service, setEntities } = fakeService([entity("a", 1)]);
		const renders: number[] = [];
		function Probe(): ReactNode {
			const snap = useVaultEntities(service, { coalesceMs: 0 });
			renders.push(snap.entities.length);
			return null;
		}
		await render(<Probe />);
		const before = renders.length;

		await act(async () => {
			setEntities([entity("a", 1), entity("b", 1)]);
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(renders.length).toBeGreaterThan(before);
		expect(renders.at(-1)).toBe(2);
	});

	it("does not re-render when onChange fires but this app's slice is unchanged", async () => {
		const { service, setEntities } = fakeService([entity("a", 5)]);
		const renders: number[] = [];
		function Probe(): ReactNode {
			useVaultEntities(service, { coalesceMs: 0 });
			renders.push(1);
			return null;
		}
		await render(<Probe />);
		const before = renders.length;

		await act(async () => {
			// Same id + same updatedAt — a write elsewhere in the vault.
			setEntities([entity("a", 5)]);
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(renders.length).toBe(before); // short-circuited by vaultSnapshotEquals
	});

	it("unsubscribes from the service on unmount (no leaked listener)", async () => {
		const { service, listenerCount } = fakeService([entity("a", 1)]);
		function Probe(): ReactNode {
			useVaultEntities(service);
			return null;
		}
		await render(<Probe />);
		expect(listenerCount()).toBe(1);
		await act(async () => root.unmount());
		expect(listenerCount()).toBe(0);
	});

	it("tolerates a null service (runtime not ready) and yields the empty snapshot", async () => {
		const captured: { snap?: VaultEntitiesSnapshot } = {};
		function Probe(): ReactNode {
			captured.snap = useVaultEntities(null);
			return null;
		}
		await render(<Probe />);
		expect(captured.snap).toEqual({ entities: [], links: [] });
	});
});

describe("useLiveEntities", () => {
	it("works over a plain repository ({ listAll }-style) source without a change channel", async () => {
		const captured: { list?: string[] } = {};
		const source = { list: () => Promise.resolve(["x", "y"]) };
		function Probe(): ReactNode {
			captured.list = useLiveEntities<string[]>(source, { initial: [] });
			return null;
		}
		await render(<Probe />);
		expect(captured.list).toEqual(["x", "y"]);
	});
});

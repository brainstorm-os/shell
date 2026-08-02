import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { type YDocTransport, createYDocResolver } from "./resolver";

/** Controllable transport: records persist/release/load, lets a test
 *  push a "canonical" update via the registered onRemote callback. */
function fakeTransport(snapshots: Record<string, Uint8Array> = {}) {
	const persisted: Array<{ id: string; update: Uint8Array }> = [];
	const released: string[] = [];
	const loadCalls: string[] = [];
	const remote = new Map<string, (u: Uint8Array) => void>();
	let failLoad = false;

	const transport: YDocTransport = {
		load: async (id) => {
			loadCalls.push(id);
			if (failLoad) throw new Error("load failed");
			return snapshots[id] ?? null;
		},
		persist: (id, update) => {
			persisted.push({ id, update });
		},
		release: (id) => {
			released.push(id);
		},
		onRemote: (id, apply) => {
			remote.set(id, apply);
			return () => remote.delete(id);
		},
	};
	return {
		transport,
		persisted,
		released,
		loadCalls,
		pushRemote: (id: string, u: Uint8Array) => remote.get(id)?.(u),
		hasRemote: (id: string) => remote.has(id),
		setFailLoad: (v: boolean) => {
			failLoad = v;
		},
	};
}

/** A Yjs update that sets `text` to `value` in a fresh doc. */
function snapshotWith(value: string): Uint8Array {
	const src = new Y.Doc();
	src.getText("t").insert(0, value);
	return Y.encodeStateAsUpdate(src);
}

/** A snapshot the canonical side claims is non-empty but that `Y.applyUpdate`
 *  rejects — a truncated valid update (the realistic disk-corruption /
 *  half-written-snapshot case). */
function corruptSnapshot(): Uint8Array {
	return snapshotWith("hello").slice(0, -1);
}

const TIMED_OUT = Symbol("timed-out");

/** Resolves true if `p` settles (resolve OR reject) within `ms`, false if it's
 *  still pending. Lets a test assert "this promise does not hang forever"
 *  without freezing the suite when the assertion fails. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof TIMED_OUT>((res) => {
		timer = setTimeout(() => res(TIMED_OUT), ms);
	});
	const winner = await Promise.race([
		p.then(() => "settled" as const).catch(() => "settled" as const),
		timeout,
	]);
	if (timer) clearTimeout(timer);
	return winner !== TIMED_OUT;
}

describe("createYDocResolver", () => {
	it("hydrates the replica from the snapshot without echoing it back as a local edit", async () => {
		const t = fakeTransport({ ent_1: snapshotWith("hello") });
		const r = createYDocResolver(t.transport);

		const handle = r.resolve("ent_1");
		await r.whenLoaded("ent_1");

		expect(handle.doc.getText("t").toString()).toBe("hello");
		expect(t.persisted).toHaveLength(0); // REMOTE_ORIGIN suppressed the echo
		expect(t.loadCalls).toEqual(["ent_1"]);
	});

	it("ships local edits to the transport", async () => {
		const t = fakeTransport();
		const r = createYDocResolver(t.transport);
		const { doc } = r.resolve("ent_1");
		await r.whenLoaded("ent_1");

		doc.getText("t").insert(0, "x");

		expect(t.persisted).toHaveLength(1);
		expect(t.persisted[0]?.id).toBe("ent_1");
		// the persisted update applies cleanly onto a fresh doc
		const check = new Y.Doc();
		Y.applyUpdate(check, t.persisted[0]?.update as Uint8Array);
		expect(check.getText("t").toString()).toBe("x");
	});

	it("applies inbound canonical updates without echoing them to persist", async () => {
		const t = fakeTransport();
		const r = createYDocResolver(t.transport);
		const { doc } = r.resolve("ent_1");
		await r.whenLoaded("ent_1");
		expect(t.hasRemote("ent_1")).toBe(true);

		t.pushRemote("ent_1", snapshotWith("remote"));

		expect(doc.getText("t").toString()).toBe("remote");
		expect(t.persisted).toHaveLength(0);
	});

	it("refcounts: shared doc + single load; canonical released only on last release", async () => {
		const t = fakeTransport({ ent_1: snapshotWith("v") });
		// retentionCap 0 isolates the refcount/teardown contract from the
		// zero-ref retention layer (exercised in its own describe block).
		const r = createYDocResolver(t.transport, { retentionCap: 0 });

		const a = r.resolve("ent_1");
		const b = r.resolve("ent_1");
		expect(a.doc).toBe(b.doc);
		expect(t.loadCalls).toEqual(["ent_1"]); // opened once

		a.release();
		expect(t.released).toEqual([]); // b still holds it
		b.release();
		expect(t.released).toEqual(["ent_1"]);

		// resolving again re-opens (fresh load)
		r.resolve("ent_1");
		expect(t.loadCalls).toEqual(["ent_1", "ent_1"]);
	});

	it("release is idempotent per handle", async () => {
		const t = fakeTransport();
		const r = createYDocResolver(t.transport, { retentionCap: 0 });
		const a = r.resolve("ent_1");
		const b = r.resolve("ent_1");
		a.release();
		a.release(); // no-op — must not over-decrement past b
		expect(t.released).toEqual([]);
		b.release();
		expect(t.released).toEqual(["ent_1"]);
	});

	it("dispose detaches every replica and releases the canonical handles", async () => {
		const t = fakeTransport();
		const r = createYDocResolver(t.transport);
		r.resolve("ent_1");
		r.resolve("ent_2");
		r.dispose();
		expect(t.released.sort()).toEqual(["ent_1", "ent_2"]);
		r.dispose(); // idempotent
		expect(t.released.sort()).toEqual(["ent_1", "ent_2"]);
	});

	it("whenLoaded resolves for unknown entities and a failed load leaves a usable empty replica", async () => {
		const t = fakeTransport();
		await expect(createYDocResolver(t.transport).whenLoaded("never-opened")).resolves.toBeUndefined();

		t.setFailLoad(true);
		const r = createYDocResolver(t.transport);
		const { doc } = r.resolve("ent_1");
		await expect(r.whenLoaded("ent_1")).resolves.toBeUndefined(); // swallowed
		doc.getText("t").insert(0, "offline");
		expect(t.persisted).toHaveLength(1); // still ships local edits
	});

	it("works without an onRemote transport (9.3.2 wiring has no inbound yet)", async () => {
		const t = fakeTransport({ ent_1: snapshotWith("base") });
		const noInbound: YDocTransport = {
			load: t.transport.load,
			persist: t.transport.persist,
			release: t.transport.release,
		};
		const r = createYDocResolver(noInbound);
		const { doc } = r.resolve("ent_1");
		await r.whenLoaded("ent_1");
		expect(doc.getText("t").toString()).toBe("base");
		doc.getText("t").insert(4, "!");
		expect(t.persisted).toHaveLength(1);
	});
});

describe("createYDocResolver via vi.fn transport", () => {
	it("calls release exactly once for a single resolve/release cycle", () => {
		const release = vi.fn();
		const r = createYDocResolver(
			{
				load: async () => null,
				persist: () => {},
				release,
			},
			{ retentionCap: 0 },
		);
		r.resolve("e").release();
		expect(release).toHaveBeenCalledExactlyOnceWith("e");
	});
});

/**
 * 9.3.2c — live cross-window convergence. Models the shell: one shared
 * "canonical" bus; `persist` from one renderer fans the delta to every
 * OTHER renderer's `onRemote` sink for that entity (the originator is
 * excluded at the service in production — modelled here by tracking
 * each transport's own sinks and skipping them).
 */
describe("createYDocResolver live cross-window convergence", () => {
	function busTransport(bus: Map<string, Set<(u: Uint8Array) => void>>) {
		const own = new Set<(u: Uint8Array) => void>();
		const transport: YDocTransport = {
			load: async () => null,
			persist: (id, update) => {
				for (const sink of bus.get(id) ?? []) {
					if (!own.has(sink)) sink(update);
				}
			},
			release: () => {},
			onRemote: (id, apply) => {
				own.add(apply);
				let set = bus.get(id);
				if (!set) {
					set = new Set();
					bus.set(id, set);
				}
				set.add(apply);
				return () => {
					set.delete(apply);
					own.delete(apply);
				};
			},
		};
		return transport;
	}

	it("an edit in window A converges into window B without a reload", () => {
		const bus = new Map<string, Set<(u: Uint8Array) => void>>();
		const persistedB: number[] = [];
		const rA = createYDocResolver(busTransport(bus));
		const tB = busTransport(bus);
		const rB = createYDocResolver({
			...tB,
			persist: (id, u) => {
				persistedB.push(u.length);
				tB.persist(id, u);
			},
		});

		const a = rA.resolve("ent_1");
		const b = rB.resolve("ent_1");
		a.doc.getText("t").insert(0, "hello");

		expect(b.doc.getText("t").toString()).toBe("hello");
		// B never made a local edit; the remote-applied update carries
		// REMOTE_ORIGIN so it is not echoed back through B's persist.
		expect(persistedB).toHaveLength(0);
	});

	it("stops delivering to a window after it detaches", () => {
		const bus = new Map<string, Set<(u: Uint8Array) => void>>();
		// retentionCap 0 — detach (offRemote) happens on last release. With
		// retention, a released-but-retained window keeps converging until
		// eviction; that's intentional and covered by the retention block.
		const rA = createYDocResolver(busTransport(bus), { retentionCap: 0 });
		const rB = createYDocResolver(busTransport(bus), { retentionCap: 0 });
		const a = rA.resolve("ent_1");
		const b = rB.resolve("ent_1");
		a.doc.getText("t").insert(0, "x");
		expect(b.doc.getText("t").toString()).toBe("x");

		b.release(); // last consumer → detach → offRemote()
		a.doc.getText("t").insert(1, "y");
		expect(b.doc.getText("t").toString()).toBe("x"); // no further delivery
	});
});

describe("createYDocResolver — load/apply failure recovery", () => {
	it("does not deadlock `loaded` when the snapshot fails to apply", async () => {
		const t = fakeTransport({ ent_1: corruptSnapshot() });
		const onError = vi.fn();
		const r = createYDocResolver(t.transport, { onError });

		const handle = r.resolve("ent_1");
		handle.applyPending?.();

		// The bug: a throw inside the apply leaves `loaded` unsettled forever.
		expect(await settlesWithin(handle.loaded as Promise<void>, 100)).toBe(true);
		expect(onError).toHaveBeenCalledWith("ent_1", expect.anything());
	});

	it("leaves the replica usable after a corrupt snapshot (local edits still ship)", async () => {
		const t = fakeTransport({ ent_1: corruptSnapshot() });
		const r = createYDocResolver(t.transport, { onError: () => {} });

		const { doc } = r.resolve("ent_1");
		await r.whenLoaded("ent_1"); // must resolve, not reject/hang

		doc.getText("t").insert(0, "z");
		expect(t.persisted).toHaveLength(1);
	});

	it("surfaces a transport load failure through onError instead of swallowing it", async () => {
		const t = fakeTransport();
		t.setFailLoad(true);
		const onError = vi.fn();
		const r = createYDocResolver(t.transport, { onError });

		r.resolve("ent_1");
		await r.whenLoaded("ent_1");

		expect(onError).toHaveBeenCalledWith("ent_1", expect.anything());
	});

	it("does not call onError on a clean load", async () => {
		const t = fakeTransport({ ent_1: snapshotWith("ok") });
		const onError = vi.fn();
		const r = createYDocResolver(t.transport, { onError });

		await r.whenLoaded("ent_1");
		r.resolve("ent_1").applyPending?.();

		expect(onError).not.toHaveBeenCalled();
	});
});

/**
 * F-486 — a rejected `transport.persist` used to be dropped on the floor.
 * A Yjs update is a DIFF: the next update does not re-carry the lost one, so
 * the canonical doc keeps a permanent hole and every struct that depends on
 * it sits in `pendingStructs` forever. Real symptom, found by the 329 audit:
 * a Journal day rendered a completely blank body while its denormalised
 * snippet still read "5 words" — 7 of the dogfood vault's journal `.ydoc`
 * files are in exactly that state, and every one of them is a Journal entry
 * (the only app that mounts an editor BEFORE its entity row is created).
 */
describe("createYDocResolver — persist failure heals instead of losing the edit", () => {
	/** Canonical side that rejects every write until the entity "exists" —
	 *  the `entities.applyDoc: <id> not found` window the Journal's implicit
	 *  create opens. */
	function canonicalTransport() {
		const canonical = new Y.Doc();
		let exists = false;
		const transport: YDocTransport = {
			load: async () => null,
			persist: async (_id, update) => {
				if (!exists) throw new Error("entities.applyDoc: ent_1 not found");
				Y.applyUpdate(canonical, update);
			},
			release: () => {},
		};
		return {
			transport,
			canonical,
			create: () => {
				exists = true;
			},
		};
	}

	async function waitFor(predicate: () => boolean, ms = 500): Promise<void> {
		const deadline = Date.now() + ms;
		while (!predicate() && Date.now() < deadline) {
			await new Promise((res) => setTimeout(res, 5));
		}
	}

	it("re-ships the full state after a rejected persist so the canonical doc has no hole", async () => {
		const c = canonicalTransport();
		const r = createYDocResolver(c.transport, { persistRetryDelaysMs: [5, 10, 20] });

		const handle = r.resolve("ent_1");
		await handle.applyPending?.();

		handle.doc.getText("t").insert(0, "hello"); // rejected — entity not created yet
		await new Promise((res) => setTimeout(res, 20));
		c.create();
		handle.doc.getText("t").insert(5, " world"); // a diff that DEPENDS on the lost one

		await waitFor(() => c.canonical.getText("t").toString() === "hello world");
		expect(c.canonical.getText("t").toString()).toBe("hello world");
		expect(c.canonical.store.pendingStructs).toBeNull();
	});

	it("reports the loss through onError once the retry budget is spent", async () => {
		const c = canonicalTransport(); // never "created" — every attempt rejects
		const onError = vi.fn();
		const r = createYDocResolver(c.transport, { onError, persistRetryDelaysMs: [1, 1] });

		const handle = r.resolve("ent_1");
		await handle.applyPending?.();
		handle.doc.getText("t").insert(0, "hello");

		await waitFor(() => onError.mock.calls.length > 0);
		expect(onError).toHaveBeenCalledWith("ent_1", expect.anything());
	});

	it("carries an unshipped edit across a revive (the seed is applied as REMOTE and never echoed)", async () => {
		const c = canonicalTransport();
		const r = createYDocResolver(c.transport, { persistRetryDelaysMs: [10_000] });

		const first = r.resolve("ent_1");
		await first.applyPending?.();
		first.doc.getText("t").insert(0, "hello"); // rejected, retry parked far out
		await new Promise((res) => setTimeout(res, 10));
		first.release(); // retained, not torn down

		c.create();
		const second = r.resolve("ent_1"); // revive: seed applied as REMOTE
		await second.applyPending?.();

		await waitFor(() => c.canonical.getText("t").toString() === "hello");
		expect(c.canonical.getText("t").toString()).toBe("hello");
	});

	it("still accepts a void-returning transport (no promise, no retry machinery)", async () => {
		const t = fakeTransport();
		const r = createYDocResolver(t.transport);
		const handle = r.resolve("ent_1");
		await handle.applyPending?.();
		handle.doc.getText("t").insert(0, "x");
		expect(t.persisted).toHaveLength(1);
	});
});

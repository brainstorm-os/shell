import { describe, expect, it, vi } from "vitest";
import { PersistFailureKind } from "./resolver";
import {
	type YDocResolverRuntime,
	b64ToBytes,
	bytesToB64,
	classifyPersistFailure,
	createYDocResolverAccessor,
} from "./resolver-accessor";

function fakeRuntime(): YDocResolverRuntime {
	return {
		services: {
			entities: {
				loadDoc: async () => ({ snapshotB64: null }),
				applyDoc: () => undefined,
				closeDoc: () => undefined,
			},
		},
		ydoc: { onRemote: () => () => {} },
	};
}

describe("createYDocResolverAccessor", () => {
	it("returns null when the runtime is absent", () => {
		expect(createYDocResolverAccessor(() => null)()).toBeNull();
	});

	it("returns null when the entities doc surface is missing", () => {
		const getApi = createYDocResolverAccessor(() => ({
			services: { entities: {} },
			ydoc: { onRemote: () => () => {} },
		}));
		expect(getApi()).toBeNull();
	});

	it("returns null when the ydoc bridge is missing", () => {
		const getApi = createYDocResolverAccessor(() => ({
			services: {
				entities: {
					loadDoc: async () => ({ snapshotB64: null }),
					applyDoc: () => undefined,
					closeDoc: () => undefined,
				},
			},
		}));
		expect(getApi()).toBeNull();
	});

	it("builds a resolver once and memoises it", () => {
		const getRuntime = vi.fn(fakeRuntime);
		const getApi = createYDocResolverAccessor(getRuntime);
		const a = getApi();
		const b = getApi();
		expect(a).not.toBeNull();
		expect(typeof a?.resolve).toBe("function");
		expect(a).toBe(b);
		// getRuntime is not consulted again once cached.
		expect(getRuntime).toHaveBeenCalledTimes(1);
	});
});

// F-486 — a not-found `applyDoc` (the Journal's implicit-create window)
// used to be swallowed here. The resolver can only heal a hole it is told
// about, so the transport must let the rejection through.
it("propagates an applyDoc rejection so the resolver can re-ship the full state", async () => {
	const applyDoc = vi.fn(async () => {
		throw new Error("entities.applyDoc: journal-2026-07-29 not found");
	});
	const getApi = createYDocResolverAccessor(() => ({
		services: {
			entities: { loadDoc: async () => ({ snapshotB64: null }), applyDoc, closeDoc: () => undefined },
		},
		ydoc: { onRemote: () => () => {} },
	}));
	const api = getApi();
	if (!api) throw new Error("expected a resolver");
	const handle = api.resolve("journal-2026-07-29");
	await handle.applyPending?.();
	handle.doc.getText("t").insert(0, "hi");
	await Promise.resolve();
	expect(applyDoc).toHaveBeenCalled();
	await expect(applyDoc.mock.results[0]?.value).rejects.toThrow(/not found/);
	api.dispose(); // cancels the parked full-state resend
});

describe("base64 round-trip", () => {
	it("bytesToB64 ∘ b64ToBytes is identity", () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64]);
		expect([...b64ToBytes(bytesToB64(bytes))]).toEqual([...bytes]);
	});
});

/**
 * F-490 — the accessor is the only layer that knows the protocol's error
 * shapes, so it owns the classification the resolver acts on. The broker puts
 * the handler's thrown `error.name` on the wire verbatim (`broker.ts` →
 * `{ kind: error.name }`) and `makeSdkError` rebuilds it renderer-side, which
 * is what makes these matchable at all.
 */
describe("classifyPersistFailure", () => {
	it("treats a refused write as Denied (no resend can change the ledger)", () => {
		const denied = new Error("entities.applyDoc: no entities.write for Note/v1");
		denied.name = "Denied";
		expect(classifyPersistFailure(denied)).toBe(PersistFailureKind.Denied);
	});

	it("treats an uncommitted row as EntityMissing, not as lost edits", () => {
		const missing = new Error("entities.applyDoc: journal-2026-07-25 not found");
		missing.name = "Invalid";
		expect(classifyPersistFailure(missing)).toBe(PersistFailureKind.EntityMissing);
	});

	it("treats anything else as Transient so the F-488 heal still runs", () => {
		const busy = new Error("entities.applyDoc: ydoc transport not wired");
		busy.name = "Unavailable";
		expect(classifyPersistFailure(busy)).toBe(PersistFailureKind.Transient);
	});

	it("treats a malformed Invalid as Transient — only a missing row is exempt", () => {
		const bad = new Error("entities.applyDoc: updateB64 is not valid base64");
		bad.name = "Invalid";
		expect(classifyPersistFailure(bad)).toBe(PersistFailureKind.Transient);
	});

	it("treats a non-Error rejection as Transient rather than guessing", () => {
		expect(classifyPersistFailure("nope")).toBe(PersistFailureKind.Transient);
	});
});

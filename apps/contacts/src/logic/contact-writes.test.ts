/**
 * The Contacts write gate — Lock-5(e), Lock-5(f), F-484.
 *
 * The Lock-5(e) version of this file tested `contactWriteRefused` in isolation:
 * a pure predicate, asserted with `toBe(true)`. That proved the PREDICATE and
 * nothing about the four call sites, so a mutation pass deleted all four gates
 * from `app.tsx` and the whole Contacts suite stayed green — the Lock-5(f)
 * finding.
 *
 * These tests drive the write FUNCTIONS instead, the ones `app.tsx` now calls
 * for every `Person/v1` write, and assert on the entities service: a refusal
 * means `update` / `delete` / `merge` / `create` was never called. Delete a
 * guard and the write behind it lands, which is what goes red here.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type ContactWriteContext,
	contactWriteRefused,
	createCompanyForWrite,
	deletePersonWrite,
	mergeContactsWrite,
	patchPersonWrite,
} from "./contact-writes";

const COMPANY_TYPE = "brainstorm/Company/v1";

type Harness = ContactWriteContext & {
	vault: {
		create: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
		merge: ReturnType<typeof vi.fn>;
	};
	patches: Array<[string, Record<string, unknown>]>;
	removals: string[][];
};

function harness(lockedIds: string[] = [], opts: { vault?: boolean } = {}): Harness {
	const locked = new Set(lockedIds);
	const vault = {
		create: vi.fn((_type: string, properties: Record<string, unknown>) =>
			Promise.resolve({ id: "co_new", properties }),
		),
		update: vi.fn(() => Promise.resolve(null)),
		delete: vi.fn(() => Promise.resolve(null)),
		merge: vi.fn(() => Promise.resolve(null)),
	};
	const patches: Array<[string, Record<string, unknown>]> = [];
	const removals: string[][] = [];
	return {
		isLocked: (id) => locked.has(id),
		vault: opts.vault === false ? null : vault,
		applyPatch: (id, patch) => void patches.push([id, patch]),
		applyRemoval: (ids) => void removals.push([...ids]),
		demoId: () => "demo_co_1",
		applyDemoMerge: () => {},
		// exposed for assertions
		...{ patches, removals },
	} as Harness;
}

describe("patchPersonWrite", () => {
	it("writes a property patch onto an UNLOCKED contact", async () => {
		const h = harness();
		expect(await patchPersonWrite(h, "free", { name: "Ada" })).toBe(true);
		expect(h.vault.update).toHaveBeenCalledWith("free", { name: "Ada" });
	});

	it("refuses every property write on a LOCKED contact", async () => {
		const h = harness(["p1"]);
		// The real surfaces, one by one: rename, the inspector cells, the icon
		// and cover pickers, the bio migration.
		expect(await patchPersonWrite(h, "p1", { name: "Ada" })).toBe(false);
		expect(await patchPersonWrite(h, "p1", { email: ["a@b.c"] })).toBe(false);
		expect(await patchPersonWrite(h, "p1", { icon: null })).toBe(false);
		expect(await patchPersonWrite(h, "p1", { cover: null })).toBe(false);
		expect(await patchPersonWrite(h, "p1", { bio: "" })).toBe(false);
		expect(h.vault.update).not.toHaveBeenCalled();
		expect(h.patches).toHaveLength(0);
	});

	it("lets the lock-flip through, so a lock can always be undone", async () => {
		const h = harness(["p1"]);
		expect(await patchPersonWrite(h, "p1", { locked: false })).toBe(true);
		expect(h.vault.update).toHaveBeenCalledWith("p1", { locked: false });
	});

	it("refuses a MIXED patch wholesale — the lock key carries nothing with it", async () => {
		const h = harness(["p1"]);
		expect(await patchPersonWrite(h, "p1", { locked: false, name: "renamed behind the lock" })).toBe(
			false,
		);
		expect(h.vault.update).not.toHaveBeenCalled();
	});

	it("refuses on the DEMO set too — the lock is not a vault-only rule", async () => {
		const h = harness(["p1"], { vault: false });
		expect(await patchPersonWrite(h, "p1", { name: "Ada" })).toBe(false);
		expect(h.patches).toHaveLength(0);
		expect(await patchPersonWrite(h, "free", { name: "Ada" })).toBe(true);
		expect(h.patches).toEqual([["free", { name: "Ada" }]]);
	});
});

describe("deletePersonWrite", () => {
	it("deletes an unlocked contact", async () => {
		const h = harness();
		expect(await deletePersonWrite(h, "free")).toBe(true);
		expect(h.vault.delete).toHaveBeenCalledWith("free");
		expect(h.removals).toEqual([["free"]]);
	});

	it("refuses to delete a LOCKED contact", async () => {
		// Delete carries no patch, so there is no lock-flip to exempt. The ⋯
		// offers Delete disabled-with-the-reason, but this is the gate at the
		// write, which the chord and the confirm dialog cannot walk around.
		const h = harness(["p1"]);
		expect(await deletePersonWrite(h, "p1")).toBe(false);
		expect(h.vault.delete).not.toHaveBeenCalled();
		expect(h.removals).toHaveLength(0);
	});
});

describe("createCompanyForWrite — '+ Add company' writes the PERSON", () => {
	it("mints the Company and links it on an unlocked contact", async () => {
		const h = harness();
		expect(await createCompanyForWrite(h, COMPANY_TYPE, "free", " Analytical Engines ")).toBe(
			"co_new",
		);
		expect(h.vault.create).toHaveBeenCalledWith(COMPANY_TYPE, { name: "Analytical Engines" });
		expect(h.vault.update).toHaveBeenCalledWith("free", { company: "co_new" });
	});

	it("refuses on a LOCKED contact — and mints NO orphan Company", async () => {
		// The gate runs before the Company exists: refusing halfway would leave
		// a Company nobody asked for and nothing points at.
		const h = harness(["p1"]);
		expect(await createCompanyForWrite(h, COMPANY_TYPE, "p1", "Analytical Engines")).toBeNull();
		expect(h.vault.create).not.toHaveBeenCalled();
		expect(h.vault.update).not.toHaveBeenCalled();
	});

	it("writes nothing for a blank name", async () => {
		const h = harness();
		expect(await createCompanyForWrite(h, COMPANY_TYPE, "free", "   ")).toBeNull();
		expect(h.vault.create).not.toHaveBeenCalled();
	});
});

describe("mergeContactsWrite — the destructive one", () => {
	it("merges when every participant is unlocked", async () => {
		const h = harness();
		expect(await mergeContactsWrite(h, "s", ["l1", "l2"], { name: "Ada" })).toBe(true);
		expect(h.vault.merge).toHaveBeenCalledWith("s", ["l1", "l2"], { name: "Ada" });
		expect(h.removals).toEqual([["l1", "l2"]]);
	});

	it("refuses the WHOLE merge when the SURVIVOR is locked", async () => {
		const h = harness(["s"]);
		expect(await mergeContactsWrite(h, "s", ["l1"], { name: "Ada" })).toBe(false);
		expect(h.vault.merge).not.toHaveBeenCalled();
	});

	it("refuses the WHOLE merge when a LOSER is locked — the data-loss case", async () => {
		// A loser is BINNED, and the merge's field-union patch is never a
		// lock-flip, so there is nothing here to exempt.
		const h = harness(["l2"]);
		expect(await mergeContactsWrite(h, "s", ["l1", "l2"], { name: "Ada" })).toBe(false);
		expect(h.vault.merge).not.toHaveBeenCalled();
		expect(h.removals).toHaveLength(0);
	});
});

describe("contactWriteRefused — the shared reading", () => {
	const isLocked = (id: string): boolean => id.startsWith("locked");

	it("refuses a patch-less write and a property write on a locked contact", () => {
		expect(contactWriteRefused(isLocked, ["locked1"], { name: "Ada" })).toBe(true);
		expect(contactWriteRefused(isLocked, ["locked1"])).toBe(true);
		expect(contactWriteRefused(isLocked, ["free"], { name: "Ada" })).toBe(false);
	});

	it("refuses a multi-id write with ONE locked member, either side", () => {
		expect(contactWriteRefused(isLocked, ["locked1", "free"])).toBe(true);
		expect(contactWriteRefused(isLocked, ["free", "locked2"])).toBe(true);
		expect(contactWriteRefused(isLocked, ["free", "free2"])).toBe(false);
	});
});

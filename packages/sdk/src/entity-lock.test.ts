import { describe, expect, it } from "vitest";
import {
	LOCKED_PROPERTY_KEY,
	anyLockRefusesWrite,
	isEntityLocked,
	isLockOnlyPatch,
	isLockedProperties,
	lockRefusesWrite,
	lockTogglePatch,
} from "./entity-lock";

describe("isLockedProperties", () => {
	it("locks only on the literal `true`", () => {
		expect(isLockedProperties({ locked: true })).toBe(true);
	});

	it("reads a missing / absent property as unlocked", () => {
		expect(isLockedProperties({})).toBe(false);
		expect(isLockedProperties(null)).toBe(false);
		expect(isLockedProperties(undefined)).toBe(false);
	});

	it("never treats a truthy non-boolean as locked (older codecs, wire skew)", () => {
		// A `"false"` string is truthy — a `Boolean(...)` reading of it would
		// lock an object the user never locked, and (worse) a `"true"` string
		// reading as unlocked would silently drop a real lock. Only `true`.
		for (const value of ["true", "false", 1, 0, "", null, undefined, {}, []]) {
			expect(isLockedProperties({ locked: value })).toBe(false);
		}
	});
});

describe("isEntityLocked", () => {
	it("reads the lock off an entity's property bag", () => {
		expect(isEntityLocked({ properties: { locked: true } })).toBe(true);
		expect(isEntityLocked({ properties: { locked: false } })).toBe(false);
		expect(isEntityLocked({ properties: {} })).toBe(false);
	});

	it("reads a missing entity as unlocked (absent ≠ locked)", () => {
		expect(isEntityLocked(null)).toBe(false);
		expect(isEntityLocked(undefined)).toBe(false);
		expect(isEntityLocked({})).toBe(false);
	});
});

describe("lockTogglePatch", () => {
	it("flips the lock", () => {
		expect(lockTogglePatch(false)).toEqual({ locked: true });
		expect(lockTogglePatch(true)).toEqual({ locked: false });
	});

	it("writes the shared property key", () => {
		expect(Object.keys(lockTogglePatch(false))).toEqual([LOCKED_PROPERTY_KEY]);
	});
});

describe("isLockOnlyPatch", () => {
	it("accepts the toggle patch itself", () => {
		expect(isLockOnlyPatch(lockTogglePatch(true))).toBe(true);
		expect(isLockOnlyPatch(lockTogglePatch(false))).toBe(true);
	});

	it("rejects a MIXED patch that merely mentions the lock", () => {
		// The key-presence spelling of this exemption let one property key
		// smuggle every other one past the gate.
		expect(isLockOnlyPatch({ locked: false, name: "renamed" })).toBe(false);
		expect(isLockOnlyPatch({ name: "renamed", locked: true })).toBe(false);
	});

	it("rejects a patch with no lock key at all, and an empty patch", () => {
		expect(isLockOnlyPatch({ name: "renamed" })).toBe(false);
		expect(isLockOnlyPatch({})).toBe(false);
		expect(isLockOnlyPatch(null)).toBe(false);
		expect(isLockOnlyPatch(undefined)).toBe(false);
	});
});

describe("lockRefusesWrite", () => {
	it("lets everything through on an unlocked object", () => {
		expect(lockRefusesWrite(false, { name: "x" })).toBe(false);
		expect(lockRefusesWrite(false, { locked: true })).toBe(false);
		expect(lockRefusesWrite(false)).toBe(false);
	});

	it("refuses a property write on a locked object", () => {
		expect(lockRefusesWrite(true, { name: "x" })).toBe(true);
	});

	it("lets the lock-flip itself through — the one write a locked object takes", () => {
		expect(lockRefusesWrite(true, lockTogglePatch(true))).toBe(false);
	});

	it("refuses a mixed patch wholesale (unlock-and-edit is TWO writes)", () => {
		expect(lockRefusesWrite(true, { locked: false, name: "renamed" })).toBe(true);
	});

	it("refuses a patch-less write (delete / merge / destroy) outright", () => {
		expect(lockRefusesWrite(true)).toBe(true);
		expect(lockRefusesWrite(true, null)).toBe(true);
	});
});

describe("anyLockRefusesWrite — the multi-object write", () => {
	const isLocked = (id: string): boolean => id.startsWith("locked");

	it("lets a write through when every participant is unlocked", () => {
		expect(anyLockRefusesWrite(isLocked, ["a", "b"], { name: "x" })).toBe(false);
		expect(anyLockRefusesWrite(isLocked, ["a", "b"])).toBe(false);
		expect(anyLockRefusesWrite(isLocked, [])).toBe(false);
	});

	it("refuses the WHOLE write when ONE participant is locked, either side", () => {
		// The merge case: the survivor takes a patch and every loser is BINNED.
		// A half-refused merge destroys some rows and keeps others, which is
		// worse than no merge — so one locked member refuses all of it.
		expect(anyLockRefusesWrite(isLocked, ["locked1", "a"])).toBe(true);
		expect(anyLockRefusesWrite(isLocked, ["a", "locked2"])).toBe(true);
	});

	it("carries the single-object patch semantics through unchanged", () => {
		expect(anyLockRefusesWrite(isLocked, ["locked1"], lockTogglePatch(true))).toBe(false);
		expect(anyLockRefusesWrite(isLocked, ["locked1"], { locked: false, name: "x" })).toBe(true);
	});
});

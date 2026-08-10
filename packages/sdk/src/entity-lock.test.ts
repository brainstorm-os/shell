import { describe, expect, it } from "vitest";
import {
	LOCKED_PROPERTY_KEY,
	isEntityLocked,
	isLockedProperties,
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

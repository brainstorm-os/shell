/**
 * Lock-5(b) — the person property rows honour the fleet's read-only lock.
 *
 * Contacts already had a `readOnly` flag, but it answered a different
 * question: "is this key computed?" (today: none are). A contact the USER
 * locked was still fully editable — every row carried a live `onChange`. The
 * rows are shared by the inline detail block AND the slide-over inspector, so
 * gating them here covers both surfaces at once.
 */

import { describe, expect, it, vi } from "vitest";
import type { Person } from "../types/person";
import { personPropertyRows } from "./person-properties-panel";

function person(locked: boolean): Person {
	return {
		id: "person-1",
		name: "Ada Lovelace",
		emails: ["ada@x.com"],
		phones: [],
		companyId: null,
		role: "Founder",
		birthday: null,
		anniversary: null,
		linkIds: [],
		bio: "",
		icon: null,
		cover: null,
		locked,
	};
}

describe("personPropertyRows", () => {
	it("an unlocked contact's rows are editable", () => {
		const rows = personPropertyRows(person(false), vi.fn());
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.readOnly === false)).toBe(true);
		expect(rows.every((r) => typeof r.onChange === "function")).toBe(true);
	});

	it("a locked contact's rows are read-only and carry NO change handler", () => {
		// Not just `readOnly` for the chrome: without dropping `onChange` the
		// row is one programmatic call away from writing, which is the lock as
		// decoration.
		const onPatch = vi.fn();
		const rows = personPropertyRows(person(true), onPatch);
		expect(rows.every((r) => r.readOnly === true)).toBe(true);
		expect(rows.every((r) => r.onChange === undefined)).toBe(true);
		expect(onPatch).not.toHaveBeenCalled();
	});
});

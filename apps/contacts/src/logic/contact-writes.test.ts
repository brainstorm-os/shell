/**
 * The Contacts write gate — Lock-5(e), F-484.
 *
 * `app.tsx` holds no lock logic of its own: `patchPerson`, `deletePerson`,
 * `createCompanyFor` and `mergeContacts` all ask this one question. Delete the
 * `lockRefusesWrite` call in `contactWriteRefused` and every test here fails,
 * which is the property the refuted Books test lacked.
 */

import { describe, expect, it } from "vitest";
import { contactWriteRefused } from "./contact-writes";

const lockedIds = new Set(["locked1", "locked2"]);
const isLocked = (id: string): boolean => lockedIds.has(id);

describe("contactWriteRefused", () => {
	it("lets a property write onto an unlocked contact through", () => {
		expect(contactWriteRefused(isLocked, ["free"], { name: "Ada" })).toBe(false);
	});

	it("refuses a property write onto a locked contact", () => {
		expect(contactWriteRefused(isLocked, ["locked1"], { name: "Ada" })).toBe(true);
		// The "+ Add company" path: a `company` ref is a property write on the
		// PERSON, so it is refused before the Company is even minted.
		expect(contactWriteRefused(isLocked, ["locked1"], { company: "co_1" })).toBe(true);
	});

	it("lets the lock-flip through so a lock can be undone", () => {
		expect(contactWriteRefused(isLocked, ["locked1"], { locked: false })).toBe(false);
	});

	it("refuses a mixed patch wholesale", () => {
		expect(contactWriteRefused(isLocked, ["locked1"], { locked: false, name: "Ada" })).toBe(true);
	});

	it("refuses a patch-less write (delete) on a locked contact", () => {
		expect(contactWriteRefused(isLocked, ["locked1"])).toBe(true);
		expect(contactWriteRefused(isLocked, ["free"])).toBe(false);
	});

	it("refuses a MERGE when any participant is locked — survivor or loser", () => {
		// The survivor takes a property patch; every loser is destroyed. Either
		// side being locked refuses the whole operation.
		expect(contactWriteRefused(isLocked, ["locked1", "free"])).toBe(true);
		expect(contactWriteRefused(isLocked, ["free", "locked2"])).toBe(true);
		expect(contactWriteRefused(isLocked, ["free", "free2"])).toBe(false);
	});

	it("does not let a merge's patch exempt a locked LOSER (there is nothing to exempt)", () => {
		// A merge is never a lock-flip, so it is asked without a patch — a
		// caller that passed the survivor's field-union patch here would be
		// exempting a destroy.
		expect(contactWriteRefused(isLocked, ["free", "locked1"])).toBe(true);
	});
});

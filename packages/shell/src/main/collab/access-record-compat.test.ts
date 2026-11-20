/**
 * Compatibility: access records written BEFORE the authorization policy keep
 * working under it, and the ones only an attacker could have written stop.
 *
 * `fixtures/access-record-0.15.json` holds real Yjs states produced by the
 * pre-policy code (`feat/0.16.0` at the commit before the policy landed): its
 * `grantAccess` / `revokeAccess` / `shareEntityWithInvite`, driven in the exact
 * shapes `SharingEngine` drives them. It is a recording — never regenerate it
 * with newer code, or it stops proving anything about vaults in the field.
 *
 * `legacyActive` is what the OLD resolver answered for each state. For every
 * legitimate record the policy must answer the same; for every attack record
 * it must answer what the record legitimately said before the attack
 * (`expectActive`), which the old resolver did not.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { base64ToBytes } from "../credentials/crypto";
import { activeMembers, docTrust } from "./access-record";
import { AccessTrustStore, inMemoryAccessTrust } from "./access-trust";
import fixture from "./fixtures/access-record-0.15.json";

type Case = (typeof fixture.cases)[number];

function load(c: Case): Y.Doc {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, base64ToBytes(c.update));
	return doc;
}

/** What a device belonging to `self` resolves the first time it reads the
 *  record after upgrading — no pin yet, so the root is taken from the doc. */
function activeOn(c: Case, self: string): string[] {
	const doc = load(c);
	const store = new AccessTrustStore(inMemoryAccessTrust(), self);
	return activeMembers(doc, c.entityId, store.trustFor(doc, c.entityId))
		.map((m) => `${m.member}:${m.role}`)
		.sort();
}

const membersOf = (c: Case): string[] => c.expectActive.map((row) => row.split(":")[0] as string);

describe("0.15 access records under the 0.16 authorization policy", () => {
	const legit = fixture.cases.filter((c) => c.legit);
	const attacks = fixture.cases.filter((c) => !c.legit);

	it("the fixture is what it claims: 5 legitimate shapes, 3 attacks the old resolver fell for", () => {
		expect(legit).toHaveLength(5);
		expect(attacks).toHaveLength(3);
		for (const c of legit) expect(c.legacyActive, c.name).toEqual(c.expectActive);
		for (const c of attacks) expect(c.legacyActive, c.name).not.toEqual(c.expectActive);
	});

	it.each(legit.map((c) => [c.name, c] as const))(
		"legitimate: %s — every member's device resolves exactly what 0.15 did",
		(_name, c) => {
			for (const self of membersOf(c)) expect(activeOn(c, self), self).toEqual(c.legacyActive);
			// And with no identity at all (a probe), the same.
			const doc = load(c);
			expect(
				activeMembers(doc, c.entityId, docTrust(doc, c.entityId))
					.map((m) => `${m.member}:${m.role}`)
					.sort(),
			).toEqual(c.legacyActive);
		},
	);

	it.each(attacks.map((c) => [c.name, c] as const))(
		"%s — has no effect on any legitimate member's device",
		(_name, c) => {
			for (const self of membersOf(c)) {
				if (self === fixture.parties.eve) continue; // the attacker's own device
				expect(activeOn(c, self), self).toEqual(c.expectActive);
			}
			expect(
				activeOn(c, fixture.parties.alice).some((row) => row.startsWith(fixture.parties.stranger)),
			).toBe(false);
		},
	);
});

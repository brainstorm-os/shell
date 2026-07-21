/**
 * Roster join tests (Collab-C6) — the pure merge of the access-record pubkey
 * roster with self + resolved profiles. Covers the invariants the service relies
 * on: self always present, dedupe + role precedence, silent members included,
 * stable ordering, and graceful unknown-profile handling.
 */

import { type RosterMember, RosterRole } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { type ResolvedDisplay, joinRoster } from "./roster";

const SELF = "self-pubkey";

/** A resolve fn backed by a name map; every pubkey gets a deterministic
 *  fingerprint, names only when present in the map. */
function resolver(names: Record<string, string>): (pk: string) => ResolvedDisplay {
	return (pk) => {
		const displayName = names[pk];
		return { fingerprint: `fp:${pk}`, ...(displayName ? { displayName } : {}) };
	};
}

function byKey(members: RosterMember[]): Record<string, RosterMember> {
	return Object.fromEntries(members.map((m) => [m.pubkey, m]));
}

describe("joinRoster", () => {
	it("always includes self as owner, even with an empty access record", () => {
		const members = joinRoster({ selfPubkey: SELF, active: [], resolve: resolver({}) });
		expect(members).toHaveLength(1);
		expect(members[0]?.pubkey).toBe(SELF);
		expect(members[0]?.isSelf).toBe(true);
		expect(members[0]?.role).toBe(RosterRole.Owner);
		expect(members[0]?.fingerprint).toBe(`fp:${SELF}`);
	});

	it("includes silent members granted access but never resolved to a name", () => {
		const members = joinRoster({
			selfPubkey: SELF,
			active: [{ pubkey: "bob", role: RosterRole.Editor }],
			resolve: resolver({}),
		});
		const bob = byKey(members).bob;
		expect(bob).toBeDefined();
		expect(bob?.role).toBe(RosterRole.Editor);
		expect(bob?.displayName).toBeUndefined();
		expect(bob?.fingerprint).toBe("fp:bob");
	});

	it("resolves display names + avatars when a profile is known", () => {
		const members = joinRoster({
			selfPubkey: SELF,
			active: [{ pubkey: "bob", role: RosterRole.Viewer }],
			resolve: (pk) =>
				pk === "bob"
					? { fingerprint: "fp:bob", displayName: "Bob", avatarRef: "asset_1" }
					: { fingerprint: `fp:${pk}` },
		});
		const bob = byKey(members).bob;
		expect(bob?.displayName).toBe("Bob");
		expect(bob?.avatarRef).toBe("asset_1");
	});

	it("dedupes a pubkey appearing twice, keeping the most privileged role", () => {
		const members = joinRoster({
			selfPubkey: SELF,
			active: [
				{ pubkey: "bob", role: RosterRole.Viewer },
				{ pubkey: "bob", role: RosterRole.Owner },
				{ pubkey: "bob", role: RosterRole.Editor },
			],
			resolve: resolver({}),
		});
		const bobs = members.filter((m) => m.pubkey === "bob");
		expect(bobs).toHaveLength(1);
		expect(bobs[0]?.role).toBe(RosterRole.Owner);
	});

	it("an explicit grant for self never lowers self below owner", () => {
		const members = joinRoster({
			selfPubkey: SELF,
			active: [{ pubkey: SELF, role: RosterRole.Viewer }],
			resolve: resolver({}),
		});
		expect(members.filter((m) => m.pubkey === SELF)).toHaveLength(1);
		expect(byKey(members)[SELF]?.role).toBe(RosterRole.Owner);
	});

	it("orders self first, then by display name, then by pubkey", () => {
		const members = joinRoster({
			selfPubkey: SELF,
			active: [
				{ pubkey: "z-no-name", role: RosterRole.Viewer },
				{ pubkey: "carol", role: RosterRole.Editor },
				{ pubkey: "anna", role: RosterRole.Editor },
			],
			resolve: resolver({ carol: "Carol", anna: "Anna" }),
		});
		expect(members.map((m) => m.pubkey)).toEqual([SELF, "anna", "carol", "z-no-name"]);
	});

	it("marks only self with isSelf", () => {
		const members = joinRoster({
			selfPubkey: SELF,
			active: [{ pubkey: "bob", role: RosterRole.Editor }],
			resolve: resolver({ bob: "Bob" }),
		});
		expect(members.filter((m) => m.isSelf)).toHaveLength(1);
		expect(members.find((m) => m.isSelf)?.pubkey).toBe(SELF);
	});
});

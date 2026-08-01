import {
	AttachmentKind,
	MessageRole,
	type RosterMember,
	RosterMemberKind,
	RosterRole,
	SenderKind,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	AUTHOR_COLORS,
	CHANNEL_TYPE,
	type EntityLike,
	MESSAGE_TYPE,
	authorColor,
	buildChannelProperties,
	buildMessageProperties,
	channelMessages,
	dayKey,
	deriveChannels,
	groupMessages,
	initials,
	membersFromMessages,
	nextSeq,
	sortMessages,
	toMessage,
	toPanelMembers,
} from "./chat";

function channel(id: string, name: string, createdAt: string): EntityLike {
	return { id, type: CHANNEL_TYPE, properties: { name, createdAt } };
}

function message(
	id: string,
	conversation: string,
	opts: { ref: string; name: string; body: string; createdAt: string; seq: number },
): EntityLike {
	return {
		id,
		type: MESSAGE_TYPE,
		properties: {
			conversation,
			body: opts.body,
			createdAt: opts.createdAt,
			seq: opts.seq,
			sender: { kind: SenderKind.Participant, personRef: opts.ref, displayName: opts.name },
		},
	};
}

describe("deriveChannels", () => {
	it("filters to channel entities and sorts oldest-created first", () => {
		const entities: EntityLike[] = [
			channel("c2", "random", "2026-06-20T10:00:00.000Z"),
			{ id: "x", type: "other/Type", properties: { name: "nope" } },
			channel("c1", "general", "2026-06-20T09:00:00.000Z"),
		];
		expect(deriveChannels(entities).map((c) => c.id)).toEqual(["c1", "c2"]);
	});

	it("falls back to 'untitled' for a nameless channel", () => {
		const [c] = deriveChannels([{ id: "c", type: CHANNEL_TYPE, properties: {} }]);
		expect(c?.name).toBe("untitled");
	});
});

describe("channelMessages", () => {
	const entities: EntityLike[] = [
		message("m2", "c1", { ref: "p1", name: "Mira", body: "second", createdAt: "t2", seq: 1 }),
		message("m1", "c1", { ref: "p2", name: "Kai", body: "first", createdAt: "t1", seq: 0 }),
		message("z", "c2", { ref: "p1", name: "Mira", body: "elsewhere", createdAt: "t0", seq: 0 }),
	];

	it("returns only the requested channel's messages, ordered by seq", () => {
		const rows = channelMessages(entities, "c1");
		expect(rows.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(rows.map((m) => m.body)).toEqual(["first", "second"]);
	});

	it("returns [] for a blank channel id", () => {
		expect(channelMessages(entities, "")).toEqual([]);
	});
});

describe("sortMessages", () => {
	it("breaks seq ties by createdAt then id", () => {
		const base = { channelId: "c", body: "", authorRef: "p", authorName: "n", attachments: [] };
		const rows = [
			{ ...base, id: "b", createdAt: "2026-06-20T00:00:02Z", seq: 5 },
			{ ...base, id: "a", createdAt: "2026-06-20T00:00:01Z", seq: 5 },
			{ ...base, id: "c", createdAt: "2026-06-20T00:00:01Z", seq: 5 },
		];
		expect(sortMessages(rows).map((m) => m.id)).toEqual(["a", "c", "b"]);
	});
});

describe("nextSeq", () => {
	it("is 0 for an empty channel and one past the max otherwise", () => {
		expect(nextSeq([])).toBe(0);
		const m = channelMessages(
			[message("m", "c", { ref: "p", name: "n", body: "x", createdAt: "t", seq: 4 })],
			"c",
		);
		expect(nextSeq(m)).toBe(5);
	});
});

describe("toMessage author", () => {
	it("reads personRef/displayName from a participant sender", () => {
		const m = toMessage(
			message("m", "c", { ref: "p1", name: "Mira", body: "hi", createdAt: "t", seq: 0 }),
		);
		expect(m).toMatchObject({ authorRef: "p1", authorName: "Mira" });
	});

	it("falls back to a per-entity anon ref + Someone for a malformed sender", () => {
		const m = toMessage({ id: "m", type: MESSAGE_TYPE, properties: { conversation: "c" } });
		expect(m.authorRef).toBe("anon:m");
		expect(m.authorName).toBe("Someone");
	});
});

describe("groupMessages", () => {
	const color = (ref: string) => `color-${ref}`;
	it("collapses consecutive same-author messages within the window into one group", () => {
		const rows = channelMessages(
			[
				message("m1", "c", {
					ref: "p1",
					name: "Mira",
					body: "a",
					createdAt: "2026-06-20T10:00:00Z",
					seq: 0,
				}),
				message("m2", "c", {
					ref: "p1",
					name: "Mira",
					body: "b",
					createdAt: "2026-06-20T10:01:00Z",
					seq: 1,
				}),
				message("m3", "c", {
					ref: "p2",
					name: "Kai",
					body: "c",
					createdAt: "2026-06-20T10:02:00Z",
					seq: 2,
				}),
			],
			"c",
		);
		const groups = groupMessages(rows, color);
		expect(groups).toHaveLength(2);
		expect(groups[0]?.messages.map((m) => m.body)).toEqual(["a", "b"]);
		expect(groups[0]?.color).toBe("color-p1");
		expect(groups[1]?.authorName).toBe("Kai");
	});

	it("splits a same-author run when the gap exceeds the window", () => {
		const rows = channelMessages(
			[
				message("m1", "c", {
					ref: "p1",
					name: "Mira",
					body: "a",
					createdAt: "2026-06-20T10:00:00Z",
					seq: 0,
				}),
				message("m2", "c", {
					ref: "p1",
					name: "Mira",
					body: "b",
					createdAt: "2026-06-20T10:30:00Z",
					seq: 1,
				}),
			],
			"c",
		);
		expect(groupMessages(rows, color)).toHaveLength(2);
	});

	it("splits across a day boundary", () => {
		const rows = channelMessages(
			[
				message("m1", "c", {
					ref: "p1",
					name: "Mira",
					body: "a",
					createdAt: "2026-06-20T23:59:00Z",
					seq: 0,
				}),
				message("m2", "c", {
					ref: "p1",
					name: "Mira",
					body: "b",
					createdAt: "2026-06-21T00:00:30Z",
					seq: 1,
				}),
			],
			"c",
		);
		const groups = groupMessages(rows, color);
		expect(groups).toHaveLength(2);
		expect(groups[0]?.dayKey).toBe("2026-06-20");
		expect(groups[1]?.dayKey).toBe("2026-06-21");
	});
});

describe("membersFromMessages", () => {
	it("lists distinct authors in first-seen order", () => {
		const rows = channelMessages(
			[
				message("m1", "c", {
					ref: "p1",
					name: "Mira",
					body: "a",
					createdAt: "2026-06-20T10:00:00Z",
					seq: 0,
				}),
				message("m2", "c", {
					ref: "p2",
					name: "Kai",
					body: "b",
					createdAt: "2026-06-20T10:01:00Z",
					seq: 1,
				}),
				message("m3", "c", {
					ref: "p1",
					name: "Mira",
					body: "c",
					createdAt: "2026-06-20T10:02:00Z",
					seq: 2,
				}),
			],
			"c",
		);
		const members = membersFromMessages(rows, authorColor);
		expect(members.map((m) => m.authorRef)).toEqual(["p1", "p2"]);
	});
});

describe("toPanelMembers", () => {
	const rosterMember = (over: Partial<RosterMember> & { pubkey: string }): RosterMember => ({
		role: RosterRole.Editor,
		kind: RosterMemberKind.Human,
		isSelf: false,
		fingerprint: `ed25519:${over.pubkey.slice(0, 16).padEnd(16, "0")}`,
		...over,
	});

	it("uses the roster as the source, resolving names + roles", () => {
		const panel = toPanelMembers({
			roster: [
				rosterMember({ pubkey: "self", isSelf: true, role: RosterRole.Owner, displayName: "Me" }),
				rosterMember({ pubkey: "bob", displayName: "Bob" }),
			],
			messageMembers: [],
			colorFor: authorColor,
		});
		expect(panel.map((m) => [m.key, m.displayName, m.isSelf, m.legacy])).toEqual([
			["self", "Me", true, false],
			["bob", "Bob", false, false],
		]);
	});

	it("includes a silent roster member with no resolved name (empty displayName)", () => {
		const panel = toPanelMembers({
			roster: [rosterMember({ pubkey: "ghost" })],
			messageMembers: [],
			colorFor: authorColor,
		});
		expect(panel[0]?.displayName).toBe("");
		expect(panel[0]?.fingerprint).toMatch(/^ed25519:/);
		expect(panel[0]?.legacy).toBe(false);
	});

	it("appends a legacy author (posted but not in the roster) as a guest", () => {
		const panel = toPanelMembers({
			roster: [rosterMember({ pubkey: "self", isSelf: true, displayName: "Me" })],
			messageMembers: [{ authorRef: "old-personref", authorName: "Old Me", color: "#000" }],
			colorFor: authorColor,
		});
		const guest = panel.find((m) => m.key === "old-personref");
		expect(guest?.legacy).toBe(true);
		expect(guest?.displayName).toBe("Old Me");
		expect(guest?.fingerprint).toBe("");
	});

	it("does not duplicate a poster already present in the roster", () => {
		const panel = toPanelMembers({
			roster: [rosterMember({ pubkey: "self", isSelf: true, displayName: "Me" })],
			messageMembers: [{ authorRef: "self", authorName: "Me", color: "#000" }],
			colorFor: authorColor,
		});
		expect(panel.filter((m) => m.key === "self")).toHaveLength(1);
	});
});

describe("authorColor", () => {
	it("is deterministic and always in the palette", () => {
		for (const ref of ["mira", "kai", "priya", "dana", "sol", ""]) {
			const c = authorColor(ref);
			expect(AUTHOR_COLORS).toContain(c);
			expect(authorColor(ref)).toBe(c);
		}
	});
});

describe("initials", () => {
	it("takes first+last initials, or first two letters of a single name", () => {
		expect(initials("Mira Anand")).toBe("MA");
		expect(initials("kai")).toBe("KA");
		expect(initials("  ")).toBe("?");
	});
});

describe("dayKey", () => {
	it("returns the UTC date portion of an ISO stamp", () => {
		expect(dayKey("2026-06-20T10:00:00.000Z")).toBe("2026-06-20");
		expect(dayKey("nope")).toBe("nope");
	});
});

describe("buildMessageProperties", () => {
	it("produces a participant-sender Message/v1 reading as a user role", () => {
		const props = buildMessageProperties({
			channelId: "c1",
			body: "hello",
			authorRef: "p1",
			authorName: "Mira",
			createdAt: "2026-06-20T10:00:00Z",
			seq: 3,
		});
		expect(props.conversation).toBe("c1");
		expect(props.role).toBe(MessageRole.User);
		expect(props.sender).toEqual({
			kind: SenderKind.Participant,
			personRef: "p1",
			displayName: "Mira",
		});
		expect(props.seq).toBe(3);
		expect(props.attachments).toBeUndefined();
	});

	it("carries attachments when present, and round-trips through toMessage", () => {
		const props = buildMessageProperties({
			channelId: "c1",
			body: "see this",
			authorRef: "p1",
			authorName: "Mira",
			createdAt: "2026-06-20T10:00:00Z",
			seq: 4,
			attachments: [
				{ kind: AttachmentKind.Entity, ref: "ent-1", label: "Spec" },
				{
					kind: AttachmentKind.Media,
					ref: "brainstorm://asset/a1",
					label: "p.png",
					mediaType: "image/png",
					image: true,
				},
			],
		});
		expect(props.attachments).toHaveLength(2);
		const round = toMessage({ id: "m", type: MESSAGE_TYPE, properties: props });
		expect(round.attachments.map((a) => a.ref)).toEqual(["ent-1", "brainstorm://asset/a1"]);
		expect(round.attachments[0]?.kind).toBe(AttachmentKind.Entity);
	});

	it("drops malformed attachment members on read (fail-soft)", () => {
		const round = toMessage({
			id: "m",
			type: MESSAGE_TYPE,
			properties: {
				conversation: "c1",
				attachments: [{ kind: "entity", ref: "ok" }, { kind: "entity" }, "garbage", 42],
			},
		});
		expect(round.attachments).toEqual([{ kind: AttachmentKind.Entity, ref: "ok" }]);
	});
});

describe("proposal cards gate on a TRUSTED LOCAL AGENT author (Agent-Teams-3 closure b)", () => {
	// The slice-2 review left this OPEN: Chat rendered an approve/discard card
	// from ANY message carrying the `agentProposal` property, so a card synced in
	// from another vault showed an Approve button that could only ever fail
	// (main refuses it — inbound rows never carry a local agent fingerprint) —
	// a UX lie and a phishing surface. The gate: the message's HOST-written
	// author (`ownerAppId` = the row's `created_by`) must resolve to a
	// shell-authored `Agent/v1` record, the renderer-side mirror of main's
	// `readTrustedAgentDef` notion.
	const AGENT_FP = "ed25519:00ff";
	const pendingProposal = {
		artifact: {
			id: "prp_1",
			kind: "task",
			entityType: "brainstorm/Task/v1",
			fields: { title: "Ship it" },
			summary: "Ship it",
		},
		status: "pending",
	};

	function agentRow(ownerAppId: string, fingerprint = AGENT_FP): EntityLike {
		return {
			id: `agt_${fingerprint}`,
			type: "brainstorm/Agent/v1",
			ownerAppId,
			properties: { fingerprint, pubkey: "pk", displayName: "Researcher" },
		};
	}

	function cardMessage(ownerAppId: string): EntityLike {
		return {
			id: "m_card",
			type: MESSAGE_TYPE,
			ownerAppId,
			properties: {
				conversation: "c1",
				body: "Proposed task: Ship it — approve it to save it.",
				createdAt: "2026-08-01T10:00:00.000Z",
				seq: 1,
				sender: { kind: SenderKind.Assistant, personRef: "pk", displayName: "Researcher" },
				agentProposal: pendingProposal,
			},
		};
	}

	it("attaches the proposal when the author is a shell-authored local agent", () => {
		const rows = channelMessages([agentRow("shell"), cardMessage(AGENT_FP)], "c1");
		expect(rows[0]?.proposal?.status).toBe("pending");
	});

	it("a synced-in card (foreign created_by) renders as an ordinary message, never a card", () => {
		// The production receive path stamps `created_by` from the type prefix
		// ("brainstorm"), and the dev bridge stamps "<pubkey> (received)" — neither
		// can ever equal a local agent fingerprint.
		for (const foreign of ["brainstorm", `${AGENT_FP} (received)`, "io.brainstorm.chat"]) {
			const rows = channelMessages([agentRow("shell"), cardMessage(foreign)], "c1");
			expect(rows[0]?.proposal).toBeUndefined();
			expect(rows[0]?.body).toContain("Proposed task");
		}
	});

	it("an Agent/v1 row NOT authored by the shell never vouches for a card", () => {
		for (const forger of ["io.evil.app", "brainstorm", `${AGENT_FP} (received)`]) {
			const rows = channelMessages([agentRow(forger), cardMessage(AGENT_FP)], "c1");
			expect(rows[0]?.proposal).toBeUndefined();
		}
	});

	it("a NON-CANONICAL spelling of a trusted fingerprint never matches", () => {
		// The class that broke an earlier fix on this track: an attacker reaches
		// for a second spelling of the same value. The comparison is exact, and
		// the shell writes fingerprints in canonical lowercase hex, so every
		// variant fails CLOSED (no card) rather than open.
		for (const variant of [
			AGENT_FP.toUpperCase(),
			`${AGENT_FP} `,
			` ${AGENT_FP}`,
			`${AGENT_FP} `,
			AGENT_FP.replace("ed25519:", "ED25519:"),
			AGENT_FP.replace("ed25519:", "ed25519::"),
			// A homoglyph — Cyrillic 'е' in "ed25519".
			AGENT_FP.replace("e", "е"),
		]) {
			expect(
				channelMessages([agentRow("shell"), cardMessage(variant)], "c1")[0]?.proposal,
			).toBeUndefined();
			// ...and the mirror: a variant on the AGENT ROW cannot vouch either.
			expect(
				channelMessages([agentRow("shell", variant), cardMessage(AGENT_FP)], "c1")[0]?.proposal,
			).toBeUndefined();
		}
	});

	it("a non-canonical status / kind spelling is not an approvable card", () => {
		for (const bad of [
			{ ...pendingProposal, status: "Pending" },
			{ ...pendingProposal, status: "pending " },
			{ ...pendingProposal, artifact: { ...pendingProposal.artifact, kind: "Task" } },
			{ ...pendingProposal, artifact: { ...pendingProposal.artifact, kind: "task " } },
		]) {
			const row = { ...cardMessage(AGENT_FP) };
			row.properties = { ...row.properties, agentProposal: bad };
			expect(channelMessages([agentRow("shell"), row], "c1")[0]?.proposal).toBeUndefined();
		}
	});

	it("no Agent/v1 record at all → no card (fail-closed default)", () => {
		expect(channelMessages([cardMessage(AGENT_FP)], "c1")[0]?.proposal).toBeUndefined();
		// And a bare toMessage (no trusted set supplied) stays fail-closed too —
		// the unread/widget projections must never resurrect a card.
		expect(toMessage(cardMessage(AGENT_FP)).proposal).toBeUndefined();
	});
});

describe("buildChannelProperties", () => {
	it("trims the name and drops an empty topic", () => {
		expect(buildChannelProperties({ name: "  general ", createdAt: "t" })).toEqual({
			name: "general",
			createdAt: "t",
		});
	});

	it("keeps a non-empty topic", () => {
		expect(buildChannelProperties({ name: "design", topic: " brand ", createdAt: "t" })).toEqual({
			name: "design",
			topic: "brand",
			createdAt: "t",
		});
	});
});

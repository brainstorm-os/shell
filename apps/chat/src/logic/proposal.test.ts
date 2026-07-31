/**
 * The chat-side proposal parser (Agent-Teams-3). The security property under
 * test is FAIL-CLOSED: only a well-formed proposal of a kind the channel path
 * can actually honour becomes an approvable card — everything else parses to
 * `null` so the row renders as an ordinary message.
 */

import { ProposeKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	CHANNEL_PROPOSAL_PROPERTY_KEY,
	type ChannelProposalArtifact,
	ChannelProposalStatus,
	ProposalDecisionFailure,
	proposalFieldRows,
	readChannelProposal,
	readDecisionResult,
} from "./proposal";

function withProposal(raw: unknown): Record<string, unknown> {
	return {
		body: "Proposed task: Ship it — approve it to save it.",
		[CHANNEL_PROPOSAL_PROPERTY_KEY]: raw,
	};
}

const pendingTask = {
	artifact: {
		id: "prop-1",
		kind: "task",
		entityType: "brainstorm/Task/v1",
		fields: { title: "Ship it", dueDate: "2026-08-02" },
		summary: "Ship it",
	},
	status: "pending",
};

describe("readChannelProposal", () => {
	it("reads a pending proposal", () => {
		const proposal = readChannelProposal(withProposal(pendingTask));
		expect(proposal).not.toBeNull();
		expect(proposal?.status).toBe(ChannelProposalStatus.Pending);
		expect(proposal?.artifact.kind).toBe("task");
		expect(proposal?.artifact.summary).toBe("Ship it");
		expect(proposal?.artifact.fields).toEqual({ title: "Ship it", dueDate: "2026-08-02" });
		expect(proposal?.createdEntityId).toBeUndefined();
	});

	it("reads an approved proposal with its created entity + decider", () => {
		const proposal = readChannelProposal(
			withProposal({
				...pendingTask,
				status: "approved",
				decidedBy: "pk-ada",
				createdEntityId: "ent_42",
				decidedAt: 1_760_000_000_000,
			}),
		);
		expect(proposal?.status).toBe(ChannelProposalStatus.Approved);
		expect(proposal?.createdEntityId).toBe("ent_42");
		expect(proposal?.decidedBy).toBe("pk-ada");
		expect(proposal?.decidedAt).toBe(1_760_000_000_000);
	});

	it("reads a discarded proposal", () => {
		const proposal = readChannelProposal(withProposal({ ...pendingTask, status: "discarded" }));
		expect(proposal?.status).toBe(ChannelProposalStatus.Discarded);
		expect(proposal?.createdEntityId).toBeUndefined();
	});

	it("is null for an ordinary message", () => {
		expect(readChannelProposal({ body: "hello team" })).toBeNull();
	});

	it.each([
		["a non-object proposal", "pending"],
		["an array proposal", [pendingTask]],
		["a null proposal", null],
		["a missing status", { artifact: pendingTask.artifact }],
		["an unknown status", { ...pendingTask, status: "maybe" }],
		["a missing artifact", { status: "pending" }],
		["a non-object artifact", { artifact: "task", status: "pending" }],
	])("is null for %s", (_label, raw) => {
		expect(readChannelProposal(withProposal(raw))).toBeNull();
	});

	it.each([
		["an unknown kind", { kind: "spaceship" }],
		// Rows / databases / code files need live schema resolution the channel
		// path never assembles — main would refuse the approval, so no card.
		["a row kind", { kind: "row" }],
		["a database kind", { kind: "database" }],
		["a code-file kind", { kind: "code-file" }],
		["a missing id", { id: undefined }],
		["an empty id", { id: "" }],
		["a non-string id", { id: 7 }],
		["a missing entityType", { entityType: undefined }],
		["an empty entityType", { entityType: "" }],
		["a missing summary", { summary: undefined }],
		["an empty summary", { summary: "" }],
		["a non-string summary", { summary: { text: "Ship it" } }],
	])("is null for %s", (_label, patch) => {
		const raw = { ...pendingTask, artifact: { ...pendingTask.artifact, ...patch } };
		expect(readChannelProposal(withProposal(raw))).toBeNull();
	});

	it("drops non-string fields rather than stringifying them", () => {
		const proposal = readChannelProposal(
			withProposal({
				...pendingTask,
				artifact: {
					...pendingTask.artifact,
					fields: { title: "Ship it", dueDate: 20_260_802, notes: null, status: "open" },
				},
			}),
		);
		expect(proposal?.artifact.fields).toEqual({ title: "Ship it", status: "open" });
	});

	it("tolerates a missing / malformed fields bag on an otherwise valid artifact", () => {
		const proposal = readChannelProposal(
			withProposal({ ...pendingTask, artifact: { ...pendingTask.artifact, fields: "nope" } }),
		);
		expect(proposal?.artifact.fields).toEqual({});
	});

	it("ignores a non-string decidedBy / createdEntityId / decidedAt", () => {
		const proposal = readChannelProposal(
			withProposal({ ...pendingTask, decidedBy: 1, createdEntityId: {}, decidedAt: "soon" }),
		);
		expect(proposal?.decidedBy).toBeUndefined();
		expect(proposal?.createdEntityId).toBeUndefined();
		expect(proposal?.decidedAt).toBeUndefined();
	});
});

describe("proposalFieldRows", () => {
	const taskArtifact = (fields: Record<string, string>): ChannelProposalArtifact => ({
		id: "prop-1",
		kind: ProposeKind.Task,
		entityType: "brainstorm/Task/v1",
		summary: "Ship it",
		fields,
	});

	it("orders rows by the descriptor, whatever order the model filled them in", () => {
		const rows = proposalFieldRows(
			taskArtifact({ notes: "n", status: "open", title: "Ship it", dueDate: "2026-08-02" }),
		);
		expect(rows.map((r) => r.key)).toEqual(["title", "dueDate", "status", "notes"]);
	});

	it("trails an unrecognised key and drops empty values", () => {
		const rows = proposalFieldRows(taskArtifact({ mystery: "?", title: "Ship it", dueDate: "" }));
		expect(rows).toEqual([
			{ key: "title", value: "Ship it" },
			{ key: "mystery", value: "?" },
		]);
	});
});

describe("readDecisionResult", () => {
	it("reads an approval that created an entity", () => {
		expect(readDecisionResult({ ok: true, status: "approved", createdEntityId: "ent_9" })).toEqual({
			ok: true,
			status: ChannelProposalStatus.Approved,
			createdEntityId: "ent_9",
		});
	});

	it("reads a discard", () => {
		expect(readDecisionResult({ ok: true, status: "discarded" })).toEqual({
			ok: true,
			status: ChannelProposalStatus.Discarded,
		});
	});

	it("passes each host failure reason through", () => {
		for (const reason of [
			ProposalDecisionFailure.NotFound,
			ProposalDecisionFailure.NotAProposal,
			ProposalDecisionFailure.AlreadyDecided,
			ProposalDecisionFailure.UntrustedAgent,
		]) {
			expect(readDecisionResult({ ok: false, reason })).toEqual({ ok: false, reason });
		}
	});

	it.each([[undefined], [null], ["ok"], [{}], [{ ok: true }], [{ ok: true, status: "maybe" }]])(
		"treats an unconfirmable reply (%p) as a failure, never a silent success",
		(reply) => {
			expect(readDecisionResult(reply)).toEqual({
				ok: false,
				reason: ProposalDecisionFailure.Unavailable,
			});
		},
	);
});

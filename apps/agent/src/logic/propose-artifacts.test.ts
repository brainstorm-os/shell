import {
	type AgentTool,
	agentToolCapabilities,
	intersectAgentTools,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	PROPOSE_DESCRIPTORS,
	PROPOSE_LONG_MAX,
	PROPOSE_SHORT_MAX,
	ProposalActionKind,
	ProposalRejectReason,
	ProposeKind,
	type ProposedArtifact,
	buildProposal,
	buildProposalAck,
	emptyProposalState,
	proposalReducer,
	proposeDescriptorForVerb,
	proposeEntityWriteCapabilities,
	proposeToolCapabilities,
	proposeTools,
} from "./propose-artifacts";

const echo = (key: string) => key;

function buildOk(verb: string, args: Record<string, unknown>, id = "d1"): ProposedArtifact {
	const r = buildProposal({ verb, args, id });
	if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
	return r.artifact;
}

describe("propose tool catalogue", () => {
	it("offers one tool per descriptor, addressed by its distinct verb", () => {
		const tools = proposeTools(echo);
		expect(tools.map((t) => t.verb).sort()).toEqual(PROPOSE_DESCRIPTORS.map((d) => d.verb).sort());
		expect(new Set(tools.map((t) => t.verb)).size).toBe(tools.length);
	});

	it("declares NO entityType — so a propose tool can never require read/write, only its dispatch verb", () => {
		for (const tool of proposeTools(echo)) {
			expect(tool.entityType).toBeUndefined();
			// The security keystone: the ONLY cap a propose tool needs is its
			// own dispatch verb — never entities.read/write. The model cannot
			// persist via a propose tool by construction.
			expect(agentToolCapabilities(tool)).toEqual([`intents.dispatch:${tool.verb}`]);
		}
	});

	it("localises the model-facing label through the injected translator", () => {
		const tools = proposeTools((k) => `T:${k}`);
		const note = tools.find((t) => t.verb === "propose-note");
		expect(note?.label).toBe("T:propose.note.label");
	});

	it("capability footprints are exact + sorted", () => {
		expect(proposeToolCapabilities()).toEqual([
			"intents.dispatch:propose-bookmark",
			"intents.dispatch:propose-contact",
			"intents.dispatch:propose-event",
			"intents.dispatch:propose-journal",
			"intents.dispatch:propose-note",
			"intents.dispatch:propose-task",
		]);
	});

	it("dedupes the entities.write caps needed at approval (Note + Journal share a type)", () => {
		const caps = proposeEntityWriteCapabilities();
		expect(caps).toContain("entities.write:io.brainstorm.notes/Note/v1");
		expect(caps).toContain("entities.write:brainstorm/Task/v1");
		// Note + Journal collapse to a single write cap.
		expect(caps.filter((c) => c.includes("Note/v1"))).toHaveLength(1);
		expect(caps).toEqual([...caps].sort());
	});

	it("resolves a verb to its descriptor; unknown verbs are null", () => {
		expect(proposeDescriptorForVerb("propose-task")?.kind).toBe(ProposeKind.Task);
		expect(proposeDescriptorForVerb("open")).toBeNull();
		expect(proposeDescriptorForVerb("propose-database")).toBeNull();
	});
});

describe("grant gating (fail-closed intersection)", () => {
	const tools: AgentTool[] = proposeTools(echo);

	it("offers a propose tool ONLY when the frozen grant covers its dispatch verb", () => {
		const grant = ["intents.dispatch:propose-task"];
		const offered = intersectAgentTools(tools, grant).map((t) => t.verb);
		expect(offered).toEqual(["propose-task"]);
	});

	it("offers nothing when no propose verb is granted", () => {
		expect(intersectAgentTools(tools, ["intents.dispatch:open"])).toEqual([]);
		expect(intersectAgentTools(tools, [])).toEqual([]);
	});

	it("a wildcard intents grant offers all propose tools", () => {
		const offered = intersectAgentTools(tools, ["intents.dispatch:*"]);
		expect(offered).toHaveLength(PROPOSE_DESCRIPTORS.length);
	});
});

describe("buildProposal — fail-closed field mapping", () => {
	it("stages a task, keeping only allowlisted fields + the primary summary", () => {
		const artifact = buildOk("propose-task", {
			title: "  Draft press release  ",
			notes: "one paragraph",
			status: "todo",
			bogus: "dropped",
			priority: 5,
		});
		expect(artifact.kind).toBe(ProposeKind.Task);
		expect(artifact.entityType).toBe("brainstorm/Task/v1");
		expect(artifact.fields).toEqual({
			title: "Draft press release",
			notes: "one paragraph",
			status: "todo",
		});
		expect(artifact.summary).toBe("Draft press release");
		expect(artifact.id).toBe("d1");
	});

	it("drops non-string values and unknown keys (no model-supplied field survives the allowlist)", () => {
		const artifact = buildOk("propose-note", { title: "Hi", body: { evil: true }, extra: 1 });
		expect(artifact.fields).toEqual({ title: "Hi" });
	});

	it("clamps long and short fields to their bounds", () => {
		const artifact = buildOk("propose-note", {
			title: "x".repeat(PROPOSE_SHORT_MAX + 50),
			body: "y".repeat(PROPOSE_LONG_MAX + 50),
		});
		expect(artifact.fields.title).toHaveLength(PROPOSE_SHORT_MAX);
		expect(artifact.fields.body).toHaveLength(PROPOSE_LONG_MAX);
	});

	it("rejects an unknown verb", () => {
		const r = buildProposal({ verb: "propose-spaceship", args: { title: "x" }, id: "d" });
		expect(r).toEqual({ ok: false, reason: ProposalRejectReason.UnknownKind });
	});

	it("rejects a missing / whitespace-only required primary field (never a silent empty write)", () => {
		expect(buildProposal({ verb: "propose-task", args: { notes: "n" }, id: "d" })).toEqual({
			ok: false,
			reason: ProposalRejectReason.MissingPrimary,
		});
		expect(buildProposal({ verb: "propose-task", args: { title: "   " }, id: "d" })).toEqual({
			ok: false,
			reason: ProposalRejectReason.MissingPrimary,
		});
	});

	it("note and journal share a type but keep distinct kinds + primary fields", () => {
		const note = buildOk("propose-note", { title: "Ideas" });
		const journal = buildOk("propose-journal", { date: "2026-07-23", body: "today" });
		expect(note.entityType).toBe(journal.entityType);
		expect(note.kind).toBe(ProposeKind.Note);
		expect(journal.kind).toBe(ProposeKind.Journal);
		expect(journal.summary).toBe("2026-07-23");
	});
});

describe("buildProposalAck — honest, never claims a save", () => {
	it("a staged ack states it is pending approval and must not be reported as done", () => {
		const ack = buildProposalAck(
			buildProposal({ verb: "propose-note", args: { title: "N" }, id: "d" }),
		);
		expect(ack.staged).toBe(true);
		expect(ack.status).toBe("pending-approval");
		expect(String(ack.note)).toMatch(/not saved|approve/i);
	});

	it("a rejected build acks the failure with its reason", () => {
		const ack = buildProposalAck(buildProposal({ verb: "propose-task", args: {}, id: "d" }));
		expect(ack).toEqual({ staged: false, reason: ProposalRejectReason.MissingPrimary });
	});
});

describe("proposalReducer — pending buffer", () => {
	const a = buildOk("propose-note", { title: "A" }, "a");
	const b = buildOk("propose-task", { title: "B" }, "b");

	it("adds and ignores a duplicate id", () => {
		let s = proposalReducer(emptyProposalState, { kind: ProposalActionKind.Add, artifact: a });
		s = proposalReducer(s, { kind: ProposalActionKind.Add, artifact: b });
		s = proposalReducer(s, { kind: ProposalActionKind.Add, artifact: a });
		expect(s.pending.map((p) => p.id)).toEqual(["a", "b"]);
	});

	it("edits merge fields and recompute the summary from the primary field", () => {
		let s = proposalReducer(emptyProposalState, { kind: ProposalActionKind.Add, artifact: a });
		s = proposalReducer(s, {
			kind: ProposalActionKind.Edit,
			id: "a",
			fields: { title: "A renamed", body: "extra" },
		});
		expect(s.pending[0]?.summary).toBe("A renamed");
		expect(s.pending[0]?.fields).toEqual({ title: "A renamed", body: "extra" });
	});

	it("discards one, removes a set, and clears all", () => {
		const s: { pending: readonly ProposedArtifact[] } = { pending: [a, b] };
		expect(proposalReducer(s, { kind: ProposalActionKind.Discard, id: "a" }).pending).toEqual([b]);
		expect(proposalReducer(s, { kind: ProposalActionKind.Remove, ids: ["a", "b"] }).pending).toEqual(
			[],
		);
		expect(proposalReducer(s, { kind: ProposalActionKind.Clear }).pending).toEqual([]);
	});
});

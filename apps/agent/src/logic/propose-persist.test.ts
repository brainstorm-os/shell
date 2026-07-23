import { describe, expect, it } from "vitest";
import { ProposeKind, type ProposedArtifact, buildProposal } from "./propose-artifacts";
import { proposalToEntityProperties } from "./propose-persist";

const NOW = 1_700_000_000_000;

function stage(verb: string, args: Record<string, unknown>): ProposedArtifact {
	const r = buildProposal({ verb, args, id: "p1" });
	if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
	return r.artifact;
}

describe("proposalToEntityProperties — schema-aware coercion", () => {
	it("maps a note to title + plain body + synthesized timestamps", () => {
		const plan = proposalToEntityProperties(
			stage("propose-note", { title: "Ideas", body: "- one\n- two" }),
			NOW,
		);
		expect(plan.entityType).toBe("io.brainstorm.notes/Note/v1");
		expect(plan.properties).toEqual({
			title: "Ideas",
			body: "- one\n- two",
			values: {},
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	it("renames a task's title→name, parses dueDate→dueAt(ms), and defaults status", () => {
		const plan = proposalToEntityProperties(
			stage("propose-task", { title: "Ship release", notes: "cut the tag", dueDate: "2026-08-01" }),
			NOW,
		);
		expect(plan.entityType).toBe("brainstorm/Task/v1");
		expect(plan.properties.name).toBe("Ship release");
		expect(plan.properties.notes).toBe("cut the tag");
		expect(plan.properties.dueAt).toBe(Date.parse("2026-08-01"));
		expect(plan.properties.statusKey).toBeNull();
		expect(plan.properties.priority).toBe("none");
		expect(plan.properties.createdAt).toBe(NOW);
	});

	it("leaves dueAt null when the model's date is unparseable (never a bogus timestamp)", () => {
		const plan = proposalToEntityProperties(
			stage("propose-task", { title: "Someday", dueDate: "next week-ish" }),
			NOW,
		);
		expect(plan.properties.dueAt).toBeNull();
	});

	it("maps an event: notes→description, start parsed, allDay synthesized, end null when absent", () => {
		const plan = proposalToEntityProperties(
			stage("propose-event", { title: "Sync", start: "2026-08-02T15:00:00Z", notes: "weekly" }),
			NOW,
		);
		expect(plan.entityType).toBe("brainstorm/Event/v1");
		expect(plan.properties.title).toBe("Sync");
		expect(plan.properties.description).toBe("weekly");
		expect(plan.properties.start).toBe(Date.parse("2026-08-02T15:00:00Z"));
		expect(plan.properties.end).toBeNull();
		expect(plan.properties.allDay).toBe(false);
		expect("location" in plan.properties).toBe(false);
	});

	it("degrades an event with an unparseable start to `now` (schema requires start)", () => {
		const plan = proposalToEntityProperties(
			stage("propose-event", { title: "Someday sync", start: "whenever" }),
			NOW,
		);
		expect(plan.properties.start).toBe(NOW);
	});

	it("maps a bookmark: note→notes, synthesizes tags[]/savedAt/timestamps", () => {
		const plan = proposalToEntityProperties(
			stage("propose-bookmark", { url: "https://x.dev", title: "X", note: "read later" }),
			NOW,
		);
		expect(plan.entityType).toBe("brainstorm/Bookmark/v1");
		expect(plan.properties).toEqual({
			url: "https://x.dev",
			title: "X",
			notes: "read later",
			tags: [],
			savedAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	it("maps a contact: notes→bio, only supplied optionals present, no timestamps", () => {
		const plan = proposalToEntityProperties(
			stage("propose-contact", { name: "Mira", email: "mira@northbound.co", notes: "lead" }),
			NOW,
		);
		expect(plan.entityType).toBe("brainstorm/Person/v1");
		expect(plan.properties).toEqual({
			name: "Mira",
			email: "mira@northbound.co",
			bio: "lead",
		});
		expect("phone" in plan.properties).toBe(false);
		expect("createdAt" in plan.properties).toBe(false);
	});

	it("every kind produces its canonical owner-app type", () => {
		const byKind: Record<ProposeKind, string> = {
			[ProposeKind.Note]: "io.brainstorm.notes/Note/v1",
			[ProposeKind.Task]: "brainstorm/Task/v1",
			[ProposeKind.Event]: "brainstorm/Event/v1",
			[ProposeKind.Bookmark]: "brainstorm/Bookmark/v1",
			[ProposeKind.Contact]: "brainstorm/Person/v1",
		};
		for (const [verb, primary] of [
			["propose-note", { title: "n" }],
			["propose-task", { title: "t" }],
			["propose-event", { title: "e", start: "2026-01-01" }],
			["propose-bookmark", { url: "https://a.b", title: "b" }],
			["propose-contact", { name: "c" }],
		] as const) {
			const artifact = stage(verb, primary);
			const plan = proposalToEntityProperties(artifact, NOW);
			expect(plan.entityType).toBe(byKind[artifact.kind]);
		}
	});
});

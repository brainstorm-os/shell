import { AGENT_PROVENANCE_PROPERTY_KEY, VersionPropertyChangeKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { diffVersionProperties, restorePatch } from "./property-diff";

describe("diffVersionProperties", () => {
	it("classifies changed / removed / added keys, sorted", () => {
		expect(diffVersionProperties({ a: 1, b: "x", c: [1] }, { a: 2, c: [1], d: true })).toEqual([
			{ key: "a", kind: VersionPropertyChangeKind.Changed, versionValue: 1, currentValue: 2 },
			{ key: "b", kind: VersionPropertyChangeKind.Removed, versionValue: "x", currentValue: null },
			{ key: "d", kind: VersionPropertyChangeKind.Added, versionValue: null, currentValue: true },
		]);
	});

	it("treats a key cleared to null since as no change", () => {
		expect(diffVersionProperties({}, { gone: null })).toEqual([]);
	});

	it("never diffs the lock or shell-owned provenance", () => {
		const prov = { agent: "a", conversationId: "c", createdAt: 1 };
		expect(
			diffVersionProperties(
				{ locked: false, [AGENT_PROVENANCE_PROPERTY_KEY]: prov },
				{ locked: true },
			),
		).toEqual([]);
	});
});

describe("restorePatch", () => {
	it("brings values back and clears keys added since", () => {
		expect(
			restorePatch({ status: "todo", title: "T" }, { status: "done", title: "T", extra: 1 }),
		).toEqual({
			status: "todo",
			extra: null,
		});
	});
	it("is empty when nothing differs", () => {
		expect(restorePatch({ a: { deep: [1, 2] } }, { a: { deep: [1, 2] } })).toEqual({});
	});
});

import { BUILTIN_ICON_PACK, type ThemeComponentRef, ThemeRefKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { BUILTIN_CHOICE_KEY, iconPackChoices, selectedChoiceKey } from "./icon-pack-options";

describe("iconPackChoices", () => {
	it("always leads with the built-in choice", () => {
		const [first] = iconPackChoices([]);
		expect(first?.key).toBe(BUILTIN_CHOICE_KEY);
		expect(first?.builtin).toBe(true);
		expect(first?.ref).toEqual({ kind: ThemeRefKind.Builtin, name: BUILTIN_ICON_PACK });
	});

	it("appends installed packs as entity-ref choices", () => {
		const choices = iconPackChoices([{ id: "p1", name: "Hand-drawn" }]);
		expect(choices).toHaveLength(2);
		expect(choices[1]).toEqual({
			key: "p1",
			name: "Hand-drawn",
			ref: { kind: ThemeRefKind.Entity, entityId: "p1" },
			builtin: false,
		});
	});
});

describe("selectedChoiceKey", () => {
	const choices = iconPackChoices([{ id: "p1", name: "Hand-drawn" }]);

	it("matches an installed entity ref to its key", () => {
		const ref: ThemeComponentRef = { kind: ThemeRefKind.Entity, entityId: "p1" };
		expect(selectedChoiceKey(choices, ref)).toBe("p1");
	});

	it("returns the builtin key for a builtin ref", () => {
		expect(selectedChoiceKey(choices, { kind: ThemeRefKind.Builtin, name: BUILTIN_ICON_PACK })).toBe(
			BUILTIN_CHOICE_KEY,
		);
	});

	it("falls back to the builtin key for an unresolved entity ref", () => {
		expect(selectedChoiceKey(choices, { kind: ThemeRefKind.Entity, entityId: "gone" })).toBe(
			BUILTIN_CHOICE_KEY,
		);
	});
});

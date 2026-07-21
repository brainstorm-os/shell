import { DropEffect } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { DropSemantic, effectForSemantic, leastDestructive } from "./drop-semantics";

describe("effectForSemantic", () => {
	it("maps the non-destructive semantics to Link", () => {
		expect(effectForSemantic(DropSemantic.Reference)).toBe(DropEffect.Link);
		expect(effectForSemantic(DropSemantic.Transclude)).toBe(DropEffect.Link);
		expect(effectForSemantic(DropSemantic.AddMembership)).toBe(DropEffect.Link);
		expect(effectForSemantic(DropSemantic.SetProperty)).toBe(DropEffect.Link);
	});

	it("maps move to Move and the create-new semantics to Copy", () => {
		expect(effectForSemantic(DropSemantic.Move)).toBe(DropEffect.Move);
		expect(effectForSemantic(DropSemantic.Copy)).toBe(DropEffect.Copy);
		expect(effectForSemantic(DropSemantic.Compose)).toBe(DropEffect.Copy);
	});

	it("covers every semantic (no missing case)", () => {
		for (const semantic of Object.values(DropSemantic)) {
			expect(Object.values(DropEffect)).toContain(effectForSemantic(semantic));
		}
	});
});

describe("leastDestructive", () => {
	it("returns null for an empty accept set", () => {
		expect(leastDestructive([])).toBeNull();
	});

	it("prefers the non-mutating reference family over move/copy", () => {
		expect(leastDestructive([DropSemantic.Move, DropSemantic.Reference])).toBe(
			DropSemantic.Reference,
		);
		expect(leastDestructive([DropSemantic.Copy, DropSemantic.AddMembership])).toBe(
			DropSemantic.AddMembership,
		);
	});

	it("never picks copy when anything else is available", () => {
		expect(leastDestructive([DropSemantic.Copy, DropSemantic.Move])).toBe(DropSemantic.Move);
		expect(leastDestructive([DropSemantic.Copy, DropSemantic.Compose])).toBe(DropSemantic.Compose);
	});

	it("returns the sole accepted semantic when there is only one", () => {
		expect(leastDestructive([DropSemantic.SetProperty])).toBe(DropSemantic.SetProperty);
		expect(leastDestructive([DropSemantic.Copy])).toBe(DropSemantic.Copy);
	});

	it("orders set-property below membership but above move", () => {
		expect(
			leastDestructive([DropSemantic.Move, DropSemantic.SetProperty, DropSemantic.AddMembership]),
		).toBe(DropSemantic.AddMembership);
		expect(leastDestructive([DropSemantic.Move, DropSemantic.SetProperty])).toBe(
			DropSemantic.SetProperty,
		);
	});
});

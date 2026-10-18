import { describe, expect, it } from "vitest";
import {
	CONFIRM_KIND_REVERSIBILITY,
	CONFIRM_SKIP_KEY_PREFIX,
	ConfirmKind,
	ConfirmReversibility,
	canRememberConfirm,
	confirmKindFromSkipKey,
	confirmSkipKey,
} from "./confirm-kind";

describe("confirm kinds (6.15)", () => {
	it("declares a reversibility for every kind", () => {
		for (const kind of Object.values(ConfirmKind)) {
			expect(Object.values(ConfirmReversibility)).toContain(CONFIRM_KIND_REVERSIBILITY[kind]);
		}
	});

	it("never lets an irreversible action be remembered", () => {
		for (const kind of [
			ConfirmKind.EmptyBin,
			ConfirmKind.PurgeFromBin,
			ConfirmKind.DeleteVault,
			ConfirmKind.RemoveCredential,
		]) {
			expect(CONFIRM_KIND_REVERSIBILITY[kind]).toBe(ConfirmReversibility.Irreversible);
			expect(canRememberConfirm(kind), kind).toBe(false);
		}
	});

	it("only a known reversible kind is rememberable", () => {
		expect(canRememberConfirm(ConfirmKind.MoveToBin)).toBe(true);
		expect(canRememberConfirm("made-up")).toBe(false);
		expect(canRememberConfirm(undefined)).toBe(false);
	});

	it("round-trips the reserved settings key", () => {
		expect(confirmSkipKey(ConfirmKind.MoveToBin)).toBe(`${CONFIRM_SKIP_KEY_PREFIX}move-to-bin`);
		expect(confirmKindFromSkipKey(confirmSkipKey(ConfirmKind.EmptyBin))).toBe(ConfirmKind.EmptyBin);
		expect(confirmKindFromSkipKey(`${CONFIRM_SKIP_KEY_PREFIX}nope`)).toBeNull();
		expect(confirmKindFromSkipKey("view.layout")).toBeNull();
	});
});

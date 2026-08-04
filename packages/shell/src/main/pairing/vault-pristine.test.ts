import { describe, expect, it } from "vitest";
import { BOOTSTRAP_PRINCIPALS, assessVaultPristine } from "./vault-pristine";

describe("assessVaultPristine", () => {
	it("an empty vault is pristine", () => {
		expect(assessVaultPristine([])).toEqual({ pristine: true, userAuthored: 0 });
	});

	it("a fresh install — root folder, welcome seed, stock agents — is pristine", () => {
		const fresh = [
			{ createdBy: "brainstorm.shell" },
			{ createdBy: "io.brainstorm.welcome" },
			{ createdBy: "io.brainstorm.welcome" },
			{ createdBy: "io.brainstorm.welcome/template" },
			{ createdBy: "shell" },
			{ createdBy: "shell" },
		];
		expect(assessVaultPristine(fresh)).toEqual({ pristine: true, userAuthored: 0 });
	});

	it("one note the user wrote makes it non-pristine", () => {
		const rows = [
			{ createdBy: "brainstorm.shell" },
			{ createdBy: "io.brainstorm.welcome" },
			// a sovereign identity key — what `entities.create` stamps
			{ createdBy: "Se7lyssNZ0D+UDiRLKxlza4GlrSMNKed861JJCAyIYQ=" },
		];
		expect(assessVaultPristine(rows)).toEqual({ pristine: false, userAuthored: 1 });
	});

	it("counts every user row, for the refusal message", () => {
		const rows = [
			{ createdBy: "io.brainstorm.welcome" },
			{ createdBy: "userkey-a" },
			{ createdBy: "userkey-a" },
			{ createdBy: "io.brainstorm.chat" },
		];
		expect(assessVaultPristine(rows).userAuthored).toBe(3);
	});

	it("fails closed on an unknown principal — a new bootstrap writer must register", () => {
		// The failure mode this guards: someone adds a bootstrap pass, forgets to
		// list it here, and pairing starts refusing. That is visible and
		// recoverable; the inverse (silently permitting an authority transfer)
		// is neither.
		expect(assessVaultPristine([{ createdBy: "io.brainstorm.some-future-seeder" }])).toEqual({
			pristine: false,
			userAuthored: 1,
		});
	});

	it("fails closed on a malformed row", () => {
		const rows = [{ createdBy: undefined }, { createdBy: null }, {}] as unknown as {
			createdBy: string;
		}[];
		expect(assessVaultPristine(rows)).toEqual({ pristine: false, userAuthored: 3 });
	});

	it("the bootstrap set is exactly the four principals this repo owns", () => {
		// A guard on the constant itself: widening it widens who may take over a
		// populated vault, so it should never change without being noticed.
		expect([...BOOTSTRAP_PRINCIPALS].sort()).toEqual([
			"brainstorm.shell",
			"io.brainstorm.welcome",
			"io.brainstorm.welcome/template",
			"shell",
		]);
	});
});

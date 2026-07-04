import { describe, expect, it } from "vitest";
import {
	AiBudgetExhausted,
	CapabilityDenied,
	Invalid,
	NotFound,
	Unavailable,
	makeSdkError,
} from "./errors";

describe("makeSdkError", () => {
	it("reconstructs the typed class for each known wire kind", () => {
		expect(makeSdkError("CapabilityDenied", "m")).toBeInstanceOf(CapabilityDenied);
		expect(makeSdkError("NotFound", "m")).toBeInstanceOf(NotFound);
		expect(makeSdkError("Unavailable", "m")).toBeInstanceOf(Unavailable);
		expect(makeSdkError("Invalid", "m")).toBeInstanceOf(Invalid);
	});

	it("14.8 — AiBudgetExhausted is a distinct, matchable class (never Unavailable)", () => {
		const err = makeSdkError("AiBudgetExhausted", "budget gone");
		expect(err).toBeInstanceOf(AiBudgetExhausted);
		expect(err).not.toBeInstanceOf(Unavailable);
		expect(err.name).toBe("AiBudgetExhausted");
		expect(err.message).toBe("budget gone");
	});

	it("unknown kinds fall through to a generic named Error", () => {
		const err = makeSdkError("Mystery", "m");
		expect(err.name).toBe("Mystery");
		expect(err).toBeInstanceOf(Error);
	});
});

import { describe, expect, it } from "vitest";
import { bakedFeedbackEndpoint, resolveFeedbackEndpoint } from "./resolve-endpoint";

describe("resolveFeedbackEndpoint", () => {
	it("uses the baked endpoint when there is no runtime override", () => {
		// The shipped case: CI baked a URL, the user's machine has no env var.
		expect(resolveFeedbackEndpoint({ baked: "https://collect.example/v1" })).toBe(
			"https://collect.example/v1",
		);
	});

	it("lets the runtime env override a baked endpoint", () => {
		// A developer pointing at a localhost collector must win over production.
		expect(
			resolveFeedbackEndpoint({
				runtime: "http://127.0.0.1:8787",
				baked: "https://collect.example/v1",
			}),
		).toBe("http://127.0.0.1:8787");
	});

	it("is null when neither source has a value", () => {
		expect(resolveFeedbackEndpoint({})).toBeNull();
		expect(resolveFeedbackEndpoint({ runtime: undefined, baked: undefined })).toBeNull();
	});

	it("treats blank and whitespace as absent, in BOTH sources", () => {
		// An env var set to "" is how CI says "no endpoint"; it must not read as a
		// usable URL, and it must not shadow a baked value either.
		expect(resolveFeedbackEndpoint({ runtime: "", baked: "" })).toBeNull();
		expect(resolveFeedbackEndpoint({ runtime: "   ", baked: "  " })).toBeNull();
		expect(resolveFeedbackEndpoint({ runtime: "  ", baked: "https://collect.example/v1" })).toBe(
			"https://collect.example/v1",
		);
	});

	it("trims a stray newline from a CI-injected value", () => {
		expect(resolveFeedbackEndpoint({ baked: "https://collect.example/v1\n" })).toBe(
			"https://collect.example/v1",
		);
	});
});

describe("bakedFeedbackEndpoint", () => {
	it("does not throw when the define is absent (vitest has no electron-vite)", () => {
		// `typeof` on an undeclared identifier is safe; a bare reference would be a
		// ReferenceError and would take down the main process at boot.
		expect(() => bakedFeedbackEndpoint()).not.toThrow();
		expect(bakedFeedbackEndpoint()).toBeUndefined();
	});
});

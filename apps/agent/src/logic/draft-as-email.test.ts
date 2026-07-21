import { SendIntentVerb } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { buildComposeEmailEnvelope } from "./draft-as-email";

describe("buildComposeEmailEnvelope (Agent-9)", () => {
	it("dispatches the compose verb with the reply as the seed body", () => {
		const env = buildComposeEmailEnvelope("Here is the summary.");
		expect(env.verb).toBe(SendIntentVerb.Compose);
		expect(env.payload).toEqual({ body: "Here is the summary." });
	});

	it("trims surrounding whitespace from the seed body", () => {
		expect(buildComposeEmailEnvelope("  hi  \n").payload.body).toBe("hi");
	});

	it("throws on an empty / whitespace-only body (caller misuse)", () => {
		expect(() => buildComposeEmailEnvelope("")).toThrow();
		expect(() => buildComposeEmailEnvelope("   \n\t ")).toThrow();
	});
});

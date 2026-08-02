/**
 * Tool-3 — broker-side argument validation + the JSON-Schema projection.
 *
 * The bypasses are pinned individually: each `it` here names a way a call
 * could have reached a provider carrying something the declaration forbade.
 */

import {
	type AppToolInput,
	DateGranularity,
	PropertyFormat,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { appToolInputsJsonSchema, validateAppToolArgs } from "./app-tool-args";

function input(partial: Partial<AppToolInput> & { name: string }): AppToolInput {
	return {
		description: "an argument",
		required: false,
		valueType: ValueType.Text,
		...partial,
	} as AppToolInput;
}

describe("validateAppToolArgs — shape", () => {
	it("rejects a non-object args payload", () => {
		for (const bad of [null, 42, "x", [], undefined]) {
			expect(validateAppToolArgs([], bad).ok).toBe(false);
		}
	});

	it("accepts an empty call against a tool that declares nothing", () => {
		const result = validateAppToolArgs([], {});
		expect(result.ok).toBe(true);
	});

	it("rejects an UNDECLARED key rather than forwarding it", () => {
		const result = validateAppToolArgs([input({ name: "query" })], { query: "a", extra: "b" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join()).toContain('unknown argument "extra"');
	});

	it("rejects a missing required argument and allows a missing optional one", () => {
		const inputs = [input({ name: "query", required: true }), input({ name: "note" })];
		expect(validateAppToolArgs(inputs, {}).ok).toBe(false);
		expect(validateAppToolArgs(inputs, { query: "hi" }).ok).toBe(true);
	});

	it("returns only declared keys, in a fresh object", () => {
		const args = { query: "hi" };
		const result = validateAppToolArgs([input({ name: "query" })], args);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.args).toEqual({ query: "hi" });
			expect(result.args).not.toBe(args);
		}
	});

	it("does not read an INHERITED key as a supplied argument", () => {
		const args = Object.create({ query: "inherited" }) as Record<string, unknown>;
		const result = validateAppToolArgs([input({ name: "query", required: true })], args);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join()).toContain("missing required");
	});

	it("type-checks each scalar", () => {
		expect(
			validateAppToolArgs([input({ name: "n", valueType: ValueType.Number })], { n: "7" }).ok,
		).toBe(false);
		expect(
			validateAppToolArgs([input({ name: "b", valueType: ValueType.Boolean })], { b: 1 }).ok,
		).toBe(false);
		expect(
			validateAppToolArgs([input({ name: "n", valueType: ValueType.Number })], { n: 7 }).ok,
		).toBe(true);
	});

	it("rejects null for any supplied key — the constraint-skipping bypass", () => {
		// Every constraint check skips a null, so accepting one would let
		// `{ mode: null }` past a choice-constrained argument and into the
		// provider, whose `default:` branch is usually the wide one. Omission is
		// how a caller says "absent", and the projection never offers null.
		for (const required of [true, false]) {
			const inputs = [input({ name: "mode", required, choices: ["fast", "slow"] })];
			expect(validateAppToolArgs(inputs, { mode: null }).ok, `required=${required}`).toBe(false);
		}
		// Omitting an optional key remains fine.
		expect(validateAppToolArgs([input({ name: "note" })], {}).ok).toBe(true);
	});

	it("strips undeclared fields off a date value instead of ferrying them through", () => {
		// `isDateValueShape` ignores extra keys while the projection declares
		// `additionalProperties: false` — passing the caller's object by
		// reference would land undeclared fields in the provider's sandbox.
		const inputs = [input({ name: "due", valueType: ValueType.Date })];
		const result = validateAppToolArgs(inputs, {
			due: { at: 5, granularity: DateGranularity.Date, smuggled: "payload" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.args.due).toEqual({ at: 5, granularity: DateGranularity.Date });
	});

	it("rejects a non-finite number", () => {
		const inputs = [input({ name: "n", valueType: ValueType.Number })];
		expect(validateAppToolArgs(inputs, { n: Number.NaN }).ok).toBe(false);
		expect(validateAppToolArgs(inputs, { n: Number.POSITIVE_INFINITY }).ok).toBe(false);
	});
});

describe("validateAppToolArgs — constraints the shared shape validator does NOT cover", () => {
	it("enforces choices", () => {
		const inputs = [input({ name: "mode", choices: ["fast", "slow"] })];
		expect(validateAppToolArgs(inputs, { mode: "fast" }).ok).toBe(true);
		expect(validateAppToolArgs(inputs, { mode: "turbo" }).ok).toBe(false);
	});

	it("anchors a pattern whole-string", () => {
		const inputs = [input({ name: "code", pattern: "[a-z]{3}" })];
		expect(validateAppToolArgs(inputs, { code: "abc" }).ok).toBe(true);
		// The bypass an unanchored regex would allow: a match anywhere inside.
		expect(validateAppToolArgs(inputs, { code: "PREFIXabcSUFFIX" }).ok).toBe(false);
	});

	it("keeps an alternation pattern intact when anchoring", () => {
		const inputs = [input({ name: "code", pattern: "yes|no" })];
		expect(validateAppToolArgs(inputs, { code: "no" }).ok).toBe(true);
		expect(validateAppToolArgs(inputs, { code: "nope" }).ok).toBe(false);
	});

	it("enforces a numeric range", () => {
		const inputs = [input({ name: "n", valueType: ValueType.Number, range: { min: 1, max: 10 } })];
		expect(validateAppToolArgs(inputs, { n: 5 }).ok).toBe(true);
		expect(validateAppToolArgs(inputs, { n: 0 }).ok).toBe(false);
		expect(validateAppToolArgs(inputs, { n: 11 }).ok).toBe(false);
	});

	it("enforces a text format", () => {
		const inputs = [input({ name: "to", format: PropertyFormat.Email })];
		expect(validateAppToolArgs(inputs, { to: "a@b.co" }).ok).toBe(true);
		expect(validateAppToolArgs(inputs, { to: "not-an-email" }).ok).toBe(false);
	});

	it("rejects a BLANK value for a declared format", () => {
		// The shared formatter treats empty as valid — right for a stored
		// property (a blank cell is unset), wrong for an argument the model was
		// told is an email.
		const inputs = [input({ name: "to", required: true, format: PropertyFormat.Email })];
		expect(validateAppToolArgs(inputs, { to: "" }).ok).toBe(false);
		expect(validateAppToolArgs(inputs, { to: "   " }).ok).toBe(false);
	});

	it("enforces a date granularity", () => {
		const inputs = [
			input({
				name: "due",
				valueType: ValueType.Date,
				granularity: DateGranularity.Date,
			}),
		];
		expect(
			validateAppToolArgs(inputs, { due: { at: 1, granularity: DateGranularity.Date } }).ok,
		).toBe(true);
		expect(
			validateAppToolArgs(inputs, { due: { at: 1, granularity: DateGranularity.DateTime } }).ok,
		).toBe(false);
		expect(validateAppToolArgs(inputs, { due: "2026-01-01" }).ok).toBe(false);
	});
});

describe("validateAppToolArgs — the pentest's argument exploits", () => {
	it("refuses a javascript:/file:/data: URL for a format:url argument", () => {
		// `isValidFormatted` is a DISPLAY validator and accepts anything `new URL`
		// parses; these were dispatched to a provider end to end.
		const inputs = [input({ name: "link", format: PropertyFormat.Url })];
		for (const evil of [
			"javascript://%0aalert(document.domain)",
			"jAvAsCrIpT://%0afetch('https://evil.example')",
			"file:///Users/admin/.ssh/id_ed25519",
			"data:text/html,<script>alert(1)</script>",
			"vbscript:msgbox(1)",
		]) {
			expect(validateAppToolArgs(inputs, { link: evil }).ok, evil).toBe(false);
		}
		for (const good of ["https://example.com/x", "http://example.com", "mailto:a@b.co"]) {
			expect(validateAppToolArgs(inputs, { link: good }).ok, good).toBe(true);
		}
	});

	it("checks and forwards the SAME url — constraints see the canonical form", () => {
		// Checking the raw string and forwarding the canonical one let a value
		// satisfy a constraint the provider then never saw honoured.
		const choiceInput = [
			input({ name: "t", format: PropertyFormat.Url, choices: ["https://example.com"] }),
		];
		const chosen = validateAppToolArgs(choiceInput, { t: "https://example.com" });
		expect(chosen.ok).toBe(true);
		// The declared choice and the forwarded value agree after canonicalising.
		if (chosen.ok) expect(chosen.args.t).toBe("https://example.com/");

		// `..` used to escape a path-pinned pattern: checked against the raw
		// string, forwarded as the resolved path.
		const pinned = [
			input({
				name: "t",
				format: PropertyFormat.Url,
				pattern: "https://api\\.example\\.com/v1/.*",
			}),
		];
		expect(validateAppToolArgs(pinned, { t: "https://api.example.com/v1/../admin" }).ok).toBe(false);
		expect(validateAppToolArgs(pinned, { t: "https://api.example.com/v1/ok" }).ok).toBe(true);
	});

	it("projects the canonical choices, so the model is shown what will match", () => {
		const schema = appToolInputsJsonSchema([
			input({ name: "t", format: PropertyFormat.Url, choices: ["https://example.com"] }),
		]) as { properties: Record<string, { enum: string[] }> };
		expect(schema.properties.t?.enum).toEqual(["https://example.com/"]);
	});

	it("forwards the PARSED url, so the provider sees what the broker checked", () => {
		const inputs = [input({ name: "link", format: PropertyFormat.Url })];
		const padded = validateAppToolArgs(inputs, { link: "   https://ok.example/   " });
		expect(padded.ok).toBe(true);
		if (padded.ok) expect(padded.args.link).toBe("https://ok.example/");
		// `https:/\host` parses to the same origin — a provider doing
		// `startsWith("https://")` on the raw string would disagree with us.
		const slashes = validateAppToolArgs(inputs, { link: "https:/\\ok.example/" });
		expect(slashes.ok).toBe(true);
		if (slashes.ok) expect(slashes.args.link).toBe("https://ok.example/");
	});

	it("refuses control characters in a formatted argument", () => {
		const inputs = [input({ name: "to", format: PropertyFormat.Email })];
		expect(validateAppToolArgs(inputs, { to: "a@b.c\u0000" }).ok).toBe(false);
		expect(validateAppToolArgs(inputs, { to: "a@b.c\n" }).ok).toBe(false);
	});

	it("validates and forwards the SAME bytes when an array lies about iteration", () => {
		// `for…of` (validation) and `.map` (output) disagree when Symbol.iterator
		// is overridden, so the validated value and the dispatched value differed.
		const sneaky: string[] = ["safe"];
		(sneaky as unknown as Record<symbol, unknown>)[Symbol.iterator] = function* () {
			yield "safe";
		};
		sneaky[0] = "DESTRUCTIVE";
		const inputs = [input({ name: "modes", count: { min: 1, max: 3 }, choices: ["safe"] })];
		const result = validateAppToolArgs(inputs, { modes: sneaky });
		// Either it refuses, or what it returns is what it checked — never a
		// value it never saw.
		if (result.ok) expect(result.args.modes).toEqual(["safe"]);
		else expect(result.ok).toBe(false);
	});

	it("validates and forwards the SAME bytes when a date value uses getters", () => {
		let reads = 0;
		const shifty = {
			at: 1,
			get granularity() {
				reads += 1;
				return reads === 1 ? DateGranularity.Date : "EVIL";
			},
		};
		const inputs = [
			input({ name: "due", valueType: ValueType.Date, granularity: DateGranularity.Date }),
		];
		const result = validateAppToolArgs(inputs, { due: shifty });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.args.due).toEqual({ at: 1, granularity: DateGranularity.Date });
		}
	});
});

describe("validateAppToolArgs — multi-valued", () => {
	const inputs = [input({ name: "ids", count: { min: 1, max: 3 } })];

	it("takes a PLAIN array, not the LabeledValue envelope", () => {
		expect(validateAppToolArgs(inputs, { ids: ["a", "b"] }).ok).toBe(true);
		expect(validateAppToolArgs(inputs, { ids: [{ value: "a" }] }).ok).toBe(false);
	});

	it("rejects a scalar where a list is declared", () => {
		expect(validateAppToolArgs(inputs, { ids: "a" }).ok).toBe(false);
	});

	it("rejects a null ITEM, which would otherwise skip the element constraints", () => {
		const constrained = [
			input({ name: "modes", count: { min: 1, max: 3 }, choices: ["fast", "slow"] }),
		];
		expect(validateAppToolArgs(constrained, { modes: ["fast", null] }).ok).toBe(false);
	});

	it("enforces the arity bounds", () => {
		expect(validateAppToolArgs(inputs, { ids: [] }).ok).toBe(false);
		expect(validateAppToolArgs(inputs, { ids: ["a", "b", "c", "d"] }).ok).toBe(false);
	});

	it("applies constraints to EVERY element, not just the first", () => {
		const constrained = [
			input({ name: "modes", count: { min: 1, max: 3 }, choices: ["fast", "slow"] }),
		];
		expect(validateAppToolArgs(constrained, { modes: ["fast", "slow"] }).ok).toBe(true);
		expect(validateAppToolArgs(constrained, { modes: ["fast", "turbo"] }).ok).toBe(false);
	});

	it("copies the array so a later caller mutation cannot reach the provider", () => {
		const ids = ["a"];
		const result = validateAppToolArgs(inputs, { ids });
		expect(result.ok).toBe(true);
		if (result.ok) {
			ids.push("mutated");
			expect(result.args.ids).toEqual(["a"]);
		}
	});
});

describe("appToolInputsJsonSchema", () => {
	it("projects the declaration the broker actually enforces", () => {
		const schema = appToolInputsJsonSchema([
			input({ name: "query", required: true, description: "what to search for" }),
			input({ name: "limit", valueType: ValueType.Number, range: { min: 1, max: 50 } }),
			input({ name: "mode", choices: ["fast", "slow"] }),
		]);
		expect(schema).toMatchObject({
			type: "object",
			required: ["query"],
			additionalProperties: false,
			properties: {
				query: { type: "string", description: "what to search for" },
				limit: { type: "number", minimum: 1, maximum: 50 },
				mode: { type: "string", enum: ["fast", "slow"] },
			},
		});
	});

	it("projects a multi-valued input as an array with its arity", () => {
		const schema = appToolInputsJsonSchema([input({ name: "ids", count: { min: 1, max: 3 } })]);
		expect(schema.properties).toMatchObject({
			ids: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
		});
	});

	it("projects the anchored pattern, so the model is told what will be enforced", () => {
		const schema = appToolInputsJsonSchema([input({ name: "code", pattern: "[a-z]{3}" })]) as {
			properties: Record<string, { pattern: string }>;
		};
		expect(schema.properties.code?.pattern).toBe("^(?:[a-z]{3})$");
	});

	it("projects a date as the wire shape, not an ISO string", () => {
		const schema = appToolInputsJsonSchema([
			input({ name: "due", valueType: ValueType.Date, granularity: DateGranularity.Date }),
		]);
		expect(schema.properties).toMatchObject({
			due: {
				type: "object",
				required: ["at", "granularity"],
				properties: { granularity: { const: DateGranularity.Date } },
			},
		});
	});

	it("never invites free-form keys — mirroring the validator's rejection", () => {
		expect(appToolInputsJsonSchema([]).additionalProperties).toBe(false);
	});

	it("keeps the entityRef type hint alongside the author's description", () => {
		// The hint used to be overwritten by the author's description for every
		// single-valued ref — i.e. in the common case.
		const schema = appToolInputsJsonSchema([
			input({
				name: "target",
				description: "Which object to act on",
				valueType: ValueType.EntityRef,
				allowedTypes: ["brainstorm/Note/v1"],
			}),
		]) as { properties: Record<string, { description: string }> };
		expect(schema.properties.target?.description).toContain("Which object to act on");
		expect(schema.properties.target?.description).toContain("brainstorm/Note/v1");
	});
});

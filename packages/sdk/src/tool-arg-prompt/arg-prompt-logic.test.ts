/**
 * Tool-8b — the argument prompt's pure logic.
 *
 * The contracts pinned here: which tools a prompt can collect for (every
 * REQUIRED input must have a face), how the draft becomes the call's args
 * (empty optionals OMITTED, booleans explicit, wire shapes per value type),
 * and that the returned bag is `validateAppToolArgs`' own output — the
 * broker-grade check runs before anything is offered to `tools.call`.
 */

import { type AppToolInput, DateGranularity, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	TOOL_ARG_FORM_ERROR,
	ToolArgFieldError,
	buildToolArgs,
	canPromptForTool,
	initialToolArgDraft,
	promptableInput,
} from "./arg-prompt-logic";

const input = (over: Partial<AppToolInput> & { name: string }): AppToolInput => ({
	description: "an argument",
	required: false,
	valueType: ValueType.Text,
	...over,
});

describe("promptableInput / canPromptForTool", () => {
	it("every single-valued type has a face; free-form multi does not", () => {
		expect(promptableInput(input({ name: "a" }))).toBe(true);
		expect(promptableInput(input({ name: "b", valueType: ValueType.Number }))).toBe(true);
		expect(promptableInput(input({ name: "c", valueType: ValueType.Boolean }))).toBe(true);
		expect(promptableInput(input({ name: "d", valueType: ValueType.Date }))).toBe(true);
		expect(promptableInput(input({ name: "e", valueType: ValueType.EntityRef }))).toBe(true);
		expect(promptableInput(input({ name: "f", count: { min: 1, max: 5 } }))).toBe(false);
		expect(
			promptableInput(input({ name: "g", count: { min: 1, max: 5 }, choices: ["x", "y"] })),
		).toBe(true);
	});

	it("a tool is promptable only when every REQUIRED input is", () => {
		expect(canPromptForTool([input({ name: "a", required: true })])).toBe(true);
		expect(
			canPromptForTool([
				input({ name: "a", required: true }),
				// Optional non-promptable inputs are fine — an omitted key is legal.
				input({ name: "b", count: { min: 0, max: 5 } }),
			]),
		).toBe(true);
		expect(canPromptForTool([input({ name: "a", required: true, count: { min: 1, max: 5 } })])).toBe(
			false,
		);
	});
});

describe("initialToolArgDraft", () => {
	it("prefills the first compatible entityRef with the menu target", () => {
		const inputs = [
			input({ name: "note", valueType: ValueType.EntityRef, allowedTypes: ["brainstorm/Note/v1"] }),
			input({ name: "any", valueType: ValueType.EntityRef }),
		];
		expect(initialToolArgDraft(inputs, { entityId: "e1", entityType: "brainstorm/Note/v1" })).toEqual(
			{ note: "e1", any: "" },
		);
		// A constrained input is never prefilled with an id of the wrong (or
		// unknown) type; the unconstrained one takes it.
		expect(initialToolArgDraft(inputs, { entityId: "e1", entityType: "brainstorm/Task/v1" })).toEqual(
			{ note: "", any: "e1" },
		);
		expect(initialToolArgDraft(inputs, { entityId: "e1" })).toEqual({ note: "", any: "e1" });
	});

	it("booleans start false, multi-choice lists empty, text empty", () => {
		expect(
			initialToolArgDraft([
				input({ name: "flag", valueType: ValueType.Boolean }),
				input({ name: "tags", count: { min: 0, max: 4 }, choices: ["a"] }),
				input({ name: "text" }),
			]),
		).toEqual({ flag: false, tags: [], text: "" });
	});
});

describe("buildToolArgs", () => {
	it("builds each wire shape and omits empty optionals", () => {
		const inputs = [
			input({ name: "text", required: true }),
			input({ name: "n", valueType: ValueType.Number }),
			input({ name: "flag", valueType: ValueType.Boolean }),
			input({ name: "when", valueType: ValueType.Date, granularity: DateGranularity.Date }),
			input({ name: "ref", valueType: ValueType.EntityRef }),
			input({ name: "blank" }),
		];
		const result = buildToolArgs(inputs, {
			text: "hello",
			n: "42",
			flag: true,
			when: "2026-08-02",
			ref: " e9 ",
			blank: "",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.args.text).toBe("hello");
		expect(result.args.n).toBe(42);
		expect(result.args.flag).toBe(true);
		expect(result.args.when).toMatchObject({ granularity: DateGranularity.Date });
		expect(typeof (result.args.when as { at: number }).at).toBe("number");
		expect(result.args.ref).toBe("e9");
		// An empty optional is OMITTED, never sent as "" or null.
		expect(Object.hasOwn(result.args, "blank")).toBe(false);
	});

	it("names the missing/unparsable field instead of calling", () => {
		const inputs = [
			input({ name: "text", required: true }),
			input({ name: "n", valueType: ValueType.Number }),
			input({ name: "when", valueType: ValueType.Date }),
		];
		const result = buildToolArgs(inputs, { text: "", n: "not-a-number", when: "not-a-date" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.fieldErrors).toEqual({
			text: ToolArgFieldError.Required,
			n: ToolArgFieldError.NotANumber,
			when: ToolArgFieldError.NotADate,
		});
	});

	it("a required multi-choice with nothing picked is a Required error", () => {
		const inputs = [
			input({ name: "tags", required: true, count: { min: 1, max: 4 }, choices: ["a", "b"] }),
		];
		const result = buildToolArgs(inputs, { tags: [] });
		expect(result).toEqual({ ok: false, fieldErrors: { tags: ToolArgFieldError.Required } });
	});

	it("runs the broker-grade validator and maps its refusals onto fields", () => {
		const inputs = [
			input({ name: "scope", required: true, choices: ["one", "two"] }),
			input({ name: "level", valueType: ValueType.Number, range: { min: 1, max: 5 } }),
		];
		const result = buildToolArgs(inputs, { scope: "three", level: "9" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.fieldErrors.scope).toBe(ToolArgFieldError.Invalid);
		expect(result.fieldErrors.level).toBe(ToolArgFieldError.Invalid);
		expect(result.fieldErrors[TOOL_ARG_FORM_ERROR]).toBeUndefined();
	});

	it("forwards the validator's OWN bag (null-prototype, frozen)", () => {
		const result = buildToolArgs([input({ name: "text", required: true })], { text: "x" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.getPrototypeOf(result.args)).toBeNull();
		expect(Object.isFrozen(result.args)).toBe(true);
	});
});

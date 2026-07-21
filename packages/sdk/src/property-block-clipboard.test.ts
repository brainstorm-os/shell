import { PropertyView } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	PROPERTY_BLOCK_MIME,
	PasteRebindKind,
	type PropertyBlockClip,
	decidePasteRebind,
	parsePropertyBlock,
	serializePropertyBlock,
} from "./property-block-clipboard";

describe("PROPERTY_BLOCK_MIME", () => {
	it("is the custom vendor flavour", () => {
		expect(PROPERTY_BLOCK_MIME).toBe("application/x-brainstorm-property-block");
	});
});

describe("serialize ↔ parse round-trip", () => {
	it("round-trips a binding with no value", () => {
		const clip: PropertyBlockClip = { propertyKey: "prop_abc", view: PropertyView.Pill };
		expect(parsePropertyBlock(serializePropertyBlock(clip))).toEqual(clip);
	});

	it("round-trips a null (default) view", () => {
		const clip: PropertyBlockClip = { propertyKey: "prop_x", view: null };
		const back = parsePropertyBlock(serializePropertyBlock(clip));
		expect(back).toEqual({ propertyKey: "prop_x", view: null });
	});

	it("round-trips an opaque copied value", () => {
		const clip: PropertyBlockClip = {
			propertyKey: "prop_v",
			view: PropertyView.TagList,
			value: [{ value: "a", label: "A" }, { value: "b" }],
		};
		expect(parsePropertyBlock(serializePropertyBlock(clip))).toEqual(clip);
	});

	it("omits `value` from the wire when undefined (no null leak)", () => {
		const wire = serializePropertyBlock({ propertyKey: "p", view: null });
		expect(JSON.parse(wire)).not.toHaveProperty("value");
	});
});

describe("parsePropertyBlock tolerance", () => {
	it("rejects non-strings, empty, and bad JSON", () => {
		for (const bad of [null, undefined, "", "{not json", "[]", "42", '"str"']) {
			expect(parsePropertyBlock(bad as string)).toBeNull();
		}
	});

	it("rejects a wrong or missing wire version", () => {
		expect(parsePropertyBlock(JSON.stringify({ propertyKey: "p", view: null }))).toBeNull();
		expect(parsePropertyBlock(JSON.stringify({ v: 2, propertyKey: "p", view: null }))).toBeNull();
	});

	it("rejects a missing / empty propertyKey", () => {
		expect(parsePropertyBlock(JSON.stringify({ v: 1, view: null }))).toBeNull();
		expect(parsePropertyBlock(JSON.stringify({ v: 1, propertyKey: "", view: null }))).toBeNull();
		expect(parsePropertyBlock(JSON.stringify({ v: 1, propertyKey: 7, view: null }))).toBeNull();
	});

	it("degrades an unknown view to null rather than rejecting the clip", () => {
		const back = parsePropertyBlock(JSON.stringify({ v: 1, propertyKey: "p", view: "not-a-view" }));
		expect(back).toEqual({ propertyKey: "p", view: null });
	});
});

describe("decidePasteRebind decision tree", () => {
	const wire = serializePropertyBlock({ propertyKey: "prop_known", view: PropertyView.Plain });

	it("rebinds when the key exists in the target", () => {
		expect(decidePasteRebind(wire, (k) => k === "prop_known")).toEqual({
			kind: PasteRebindKind.Rebind,
			propertyKey: "prop_known",
			view: PropertyView.Plain,
		});
	});

	it("carries the copied value through a rebind when present", () => {
		const valued = serializePropertyBlock({
			propertyKey: "prop_known",
			view: null,
			value: 42,
		});
		expect(decidePasteRebind(valued, () => true)).toEqual({
			kind: PasteRebindKind.Rebind,
			propertyKey: "prop_known",
			view: null,
			value: 42,
		});
	});

	it("prompts/creates when the key is unknown to the target", () => {
		const d = decidePasteRebind(wire, () => false);
		expect(d.kind).toBe(PasteRebindKind.CreateOrPrompt);
		if (d.kind === PasteRebindKind.CreateOrPrompt) {
			expect(d.clip).toEqual({ propertyKey: "prop_known", view: PropertyView.Plain });
		}
	});

	it("ignores a non-property-block / malformed payload (host pastes normally)", () => {
		expect(decidePasteRebind("plain text", () => true)).toEqual({
			kind: PasteRebindKind.Ignore,
		});
		expect(decidePasteRebind(null, () => true)).toEqual({ kind: PasteRebindKind.Ignore });
	});
});

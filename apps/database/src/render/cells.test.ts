/**
 * VP-7c parity: with a real vault `PropertyDef` resolved, scalar
 * formatting routes through `@brainstorm-os/sdk/property-ui/pure`'s
 * `formatScalar` — the exact code Notes' cells run. These assert the
 * schema-driven path matches the standalone heuristic on the demo
 * dataset's shapes (so the move is behaviour-preserving), and that the
 * no-schema fallback is byte-for-byte unchanged.
 */

import type { PropertiesSnapshot, PropertyDef } from "@brainstorm-os/sdk-types";
import { DateGranularity, PropertyFormat, ValueType } from "@brainstorm-os/sdk-types";
import { afterEach, describe, expect, it } from "vitest";
import type { EntityRow } from "../logic/in-memory-entities";
import {
	buildPropertyDefResolver,
	buildVocabularyLabelResolver,
	buildVocabularyResolver,
	installPropertyDefResolver,
	installVocabularyLabelResolver,
	installVocabularyResolver,
} from "../logic/property-resolver";
import { renderCell } from "./cells";

function pdef(over: Partial<PropertyDef> & { key: string; valueType: ValueType }): PropertyDef {
	return { name: over.key, icon: null, ...over };
}

function row(properties: Record<string, unknown>): EntityRow {
	return {
		id: "e1",
		type: "io.brainstorm.demo/Task/v1",
		properties,
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

const snapshot: PropertiesSnapshot = {
	properties: {
		status: pdef({
			key: "status",
			valueType: ValueType.Text,
			vocabulary: { dictionaryId: "d-status" },
		}),
		title: pdef({ key: "title", valueType: ValueType.Text }),
		pages: pdef({ key: "pages", valueType: ValueType.Number }),
		cost: pdef({ key: "cost", valueType: ValueType.Number, format: PropertyFormat.Currency }),
		dueDate: pdef({
			key: "dueDate",
			valueType: ValueType.Date,
			granularity: DateGranularity.Date,
		}),
		done: pdef({ key: "done", valueType: ValueType.Boolean }),
	},
	dictionaries: {
		"d-status": {
			id: "d-status",
			name: "Status",
			items: [{ id: "s1", label: "Done", icon: null, sortIndex: 0, colour: "#34d399" }],
		},
	},
};

afterEach(() => {
	installPropertyDefResolver(buildPropertyDefResolver(null));
	installVocabularyResolver(() => null);
	installVocabularyLabelResolver(() => undefined);
});

describe("renderCell — schema-driven path (PropertyDef resolved)", () => {
	function withSnapshot(): void {
		installPropertyDefResolver(buildPropertyDefResolver(snapshot));
		installVocabularyResolver(buildVocabularyResolver(snapshot, () => null));
		installVocabularyLabelResolver(buildVocabularyLabelResolver(snapshot));
	}

	it("formats a number through formatScalar (locale grouping)", () => {
		withSnapshot();
		const cell = renderCell(row({ pages: 1234 }), "pages");
		expect(cell.kind).toBe("number");
		expect(cell.text).toBe((1234).toLocaleString());
	});

	it("formats currency through formatScalar (money kind)", () => {
		withSnapshot();
		const cell = renderCell(row({ cost: 4200 }), "cost");
		expect(cell.kind).toBe("money");
		expect(cell.text).toContain("4,200");
	});

	it("formats a date (bare epoch-ms) through formatScalar", () => {
		withSnapshot();
		const at = new Date("2026-05-20T00:00:00Z").getTime();
		const cell = renderCell(row({ dueDate: at }), "dueDate");
		expect(cell.kind).toBe("date");
		expect(cell.text).toBe(
			new Date(at).toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			}),
		);
	});

	it("paints an unknown vocabulary value as a plain (uncoloured) chip", () => {
		withSnapshot();
		// A value that's no longer a known option id still renders as a chip,
		// showing the raw text with no colour (graceful fallback).
		const cell = renderCell(row({ status: "legacy-text" }), "status");
		expect(cell.kind).toBe("pill");
		expect(cell.text).toBe("legacy-text");
		expect(cell.color).toBe(null);
	});

	it("resolves a Select stored as an option id to its label + colour (F-031)", () => {
		withSnapshot();
		// Selects store the option id ("s1"), not the label — both label and
		// colour resolve from that id.
		const cell = renderCell(row({ status: "s1" }), "status");
		expect(cell.kind).toBe("pill");
		expect(cell.text).toBe("Done");
		expect(cell.color).toBe("#34d399");
	});

	it("renders a boolean as a checkbox", () => {
		withSnapshot();
		expect(renderCell(row({ done: true }), "done").kind).toBe("checkbox");
		expect(renderCell(row({ done: true }), "done").text).toBe("Yes");
	});

	it("empty value stays empty under the schema path", () => {
		withSnapshot();
		expect(renderCell(row({ title: "" }), "title").kind).toBe("empty");
		expect(renderCell(row({}), "pages").kind).toBe("empty");
	});
});

describe("renderCell — standalone fallback (no PropertyDef) unchanged", () => {
	it("number / money heuristic still applies with no snapshot installed", () => {
		// resolvers reset by afterEach → null; this is the standalone-dev path.
		const num = renderCell(row({ pages: 1234 }), "pages");
		expect(num.kind).toBe("number");
		expect(num.text).toBe((1234).toLocaleString());

		const money = renderCell(row({ cost: 4200 }), "cost");
		expect(money.kind).toBe("money");
		expect(money.text).toBe("$4,200");
	});

	it("plain text + empty heuristic unchanged with no snapshot", () => {
		expect(renderCell(row({ title: "Hello" }), "title")).toMatchObject({
			kind: "text",
			text: "Hello",
		});
		expect(renderCell(row({ title: "" }), "title").kind).toBe("empty");
	});

	it("array value → tags heuristic unchanged with no snapshot", () => {
		const cell = renderCell(row({ tags: ["a", "b"] }), "tags");
		expect(cell.kind).toBe("tags");
		expect(cell.text).toBe("a, b");
	});
});

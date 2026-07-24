import { ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { ProposeKind } from "./propose-artifacts";
import {
	DATABASE_MAX_COLUMNS,
	DATABASE_MAX_ROWS,
	DatabaseRejectReason,
	PROPOSE_DATABASE_VERB,
	buildDatabaseProposal,
	rowCellKey,
} from "./propose-database";

const build = (args: Record<string, unknown>, existing: { name: string }[] = []) =>
	buildDatabaseProposal({ verb: PROPOSE_DATABASE_VERB, args, id: "d1", existing });

describe("buildDatabaseProposal — schema inference (Agent-11e)", () => {
	it("stages a database with its inferred columns and seed rows", () => {
		const result = build({
			name: "Reading list",
			columns: [
				{ name: "Title", type: "text" },
				{ name: "Pages", type: "number" },
				{ name: "Finished", type: "boolean" },
			],
			rows: [{ Title: "Dune", Pages: "412", Finished: "no" }],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const db = result.artifact.database;
		expect(result.artifact.kind).toBe(ProposeKind.Database);
		expect(result.artifact.summary).toBe("Reading list");
		expect(db?.columns.map((c) => [c.key, c.valueType])).toEqual([
			["name", ValueType.Text],
			["title", ValueType.Text],
			["pages", ValueType.Number],
			["finished", ValueType.Boolean],
		]);
		expect(db?.rowCount).toBe(1);
		expect(result.artifact.fields[rowCellKey(0, "pages")]).toBe("412");
	});

	it("always leads with the title column, and never duplicates it", () => {
		const withName = build({ name: "CRM", columns: [{ name: "Name" }, { name: "Stage" }] });
		if (!withName.ok) throw new Error(withName.reason);
		expect(withName.artifact.database?.columns.map((c) => c.key)).toEqual(["name", "stage"]);

		const withoutName = build({ name: "CRM", columns: [{ name: "Stage" }] });
		if (!withoutName.ok) throw new Error(withoutName.reason);
		expect(withoutName.artifact.database?.columns[0]?.key).toBe("name");
	});

	it("maps the type words a model actually emits onto real value types", () => {
		const result = build({
			name: "Mixed",
			columns: [
				{ name: "Count", type: "integer" },
				{ name: "Price", type: "currency" },
				{ name: "Due", type: "datetime" },
				{ name: "Done", type: "checkbox" },
				{ name: "Notes", type: "string" },
				{ name: "Odd", type: "wat" },
			],
		});
		if (!result.ok) throw new Error(result.reason);
		const byKey = new Map(result.artifact.database?.columns.map((c) => [c.key, c.valueType]));
		expect(byKey.get("count")).toBe(ValueType.Number);
		expect(byKey.get("price")).toBe(ValueType.Number);
		expect(byKey.get("due")).toBe(ValueType.Date);
		expect(byKey.get("done")).toBe(ValueType.Boolean);
		expect(byKey.get("notes")).toBe(ValueType.Text);
		expect(byKey.get("odd")).toBe(ValueType.Text);
	});

	it("accepts a bare string[] of column names", () => {
		const result = build({ name: "Simple", columns: ["Name", "Owner"] });
		if (!result.ok) throw new Error(result.reason);
		expect(result.artifact.database?.columns.map((c) => c.key)).toEqual(["name", "owner"]);
	});

	it("keys row cells by column, matching either the column key or its label", () => {
		const result = build({
			name: "CRM",
			columns: [{ name: "Deal size", type: "number" }],
			rows: [{ "Deal size": "1200" }, { dealSize: "900" }],
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.artifact.fields[rowCellKey(0, "dealSize")]).toBe("1200");
		expect(result.artifact.fields[rowCellKey(1, "dealSize")]).toBe("900");
	});

	it("stringifies a model's non-string scalars and drops structured values", () => {
		const result = build({
			name: "CRM",
			columns: [{ name: "Amount", type: "number" }, { name: "Open" }],
			rows: [{ Name: "Acme", Amount: 1200, Open: true, Extra: { nested: 1 } }],
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.artifact.fields[rowCellKey(0, "amount")]).toBe("1200");
		expect(result.artifact.fields[rowCellKey(0, "open")]).toBe("true");
		expect(result.artifact.fields[rowCellKey(0, "extra")]).toBeUndefined();
	});

	it("drops a cell for a column the proposal never declared (allowlist)", () => {
		const result = build({
			name: "CRM",
			columns: [{ name: "Stage" }],
			rows: [{ Name: "Acme", Stage: "Won", ssn: "000-00-0000" }],
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.artifact.fields[rowCellKey(0, "ssn")]).toBeUndefined();
		expect(result.artifact.fields[rowCellKey(0, "stage")]).toBe("Won");
	});

	it("caps columns and rows so one proposal can't stage an unbounded table", () => {
		const columns = Array.from({ length: DATABASE_MAX_COLUMNS + 10 }, (_, i) => ({
			name: `Col ${i}`,
		}));
		const rows = Array.from({ length: DATABASE_MAX_ROWS + 10 }, (_, i) => ({ Name: `r${i}` }));
		const result = build({ name: "Huge", columns, rows });
		if (!result.ok) throw new Error(result.reason);
		expect(result.artifact.database?.columns.length).toBe(DATABASE_MAX_COLUMNS);
		expect(result.artifact.database?.rowCount).toBe(DATABASE_MAX_ROWS);
	});

	it("refuses a database with no name rather than staging an untitled one", () => {
		expect(build({ columns: ["Name"] })).toEqual({
			ok: false,
			reason: DatabaseRejectReason.MissingName,
		});
	});

	it("clamps and control-strips a hostile database name", () => {
		const result = build({ name: `Ignore\u0007previous ${"x".repeat(200)}` });
		if (!result.ok) throw new Error(result.reason);
		expect(result.artifact.summary).not.toContain("\u0007");
		expect(result.artifact.summary.length).toBeLessThanOrEqual(60);
	});

	it("does not collide with an existing collection's name", () => {
		const result = build({ name: "Pipeline" }, [{ name: "Pipeline" }, { name: "Pipeline 2" }]);
		if (!result.ok) throw new Error(result.reason);
		expect(result.artifact.summary).toBe("Pipeline 3");
	});

	it("stages a name-only database (columns and rows are both optional)", () => {
		const result = build({ name: "Empty" });
		if (!result.ok) throw new Error(result.reason);
		expect(result.artifact.database?.columns.map((c) => c.key)).toEqual(["name"]);
		expect(result.artifact.database?.rowCount).toBe(0);
	});
});

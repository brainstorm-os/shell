import type { EntityRow } from "@brainstorm-os/sdk/in-memory-entities";
import { describe, expect, it } from "vitest";
import {
	type ExportMatrix,
	ListExportFormat,
	buildExportMatrix,
	extensionFor,
	serializeList,
	toCsv,
	toJson,
	toMarkdown,
	valueToCell,
} from "./list-export";

const MATRIX: ExportMatrix = {
	headers: ["Name", "Status"],
	rows: [
		["Buy milk", "todo"],
		["Ship it", "done"],
	],
};

function row(id: string, properties: Record<string, unknown>): EntityRow {
	return { id, type: "brainstorm/Task/v1", properties, createdAt: 0, updatedAt: 0, deletedAt: null };
}

describe("valueToCell", () => {
	it("blanks null / undefined", () => {
		expect(valueToCell(null)).toBe("");
		expect(valueToCell(undefined)).toBe("");
	});
	it("joins arrays with '; ' and drops empties", () => {
		expect(valueToCell(["a", "", "b"])).toBe("a; b");
	});
	it("JSON-encodes plain objects", () => {
		expect(valueToCell({ a: 1 })).toBe('{"a":1}');
	});
	it("stringifies scalars", () => {
		expect(valueToCell(42)).toBe("42");
		expect(valueToCell(true)).toBe("true");
	});
});

describe("buildExportMatrix", () => {
	it("prepends a Name column and reads each column's property", () => {
		const rows = [row("a", { status: "todo", score: 3 }), row("b", { status: "done", score: 7 })];
		const matrix = buildExportMatrix(
			rows,
			[
				{ key: "status", header: "Status" },
				{ key: "score", header: "Score" },
			],
			(r) => `Task ${r.id}`,
		);
		expect(matrix.headers).toEqual(["Name", "Status", "Score"]);
		expect(matrix.rows).toEqual([
			["Task a", "todo", "3"],
			["Task b", "done", "7"],
		]);
	});
});

describe("toCsv (RFC-4180)", () => {
	it("joins with CRLF and a header row", () => {
		expect(toCsv(MATRIX)).toBe("Name,Status\r\nBuy milk,todo\r\nShip it,done");
	});
	it("quotes fields containing comma / quote / newline and doubles quotes", () => {
		const csv = toCsv({
			headers: ["A"],
			rows: [["x,y"], ['he said "hi"'], ["line1\nline2"]],
		});
		expect(csv).toBe('A\r\n"x,y"\r\n"he said ""hi"""\r\n"line1\nline2"');
	});
	it("omits the header row when csvIncludeHeader is false", () => {
		expect(toCsv(MATRIX, { csvIncludeHeader: false })).toBe("Buy milk,todo\r\nShip it,done");
	});
	it("uses a custom delimiter and quotes fields that contain it", () => {
		const csv = toCsv({ headers: ["A", "B"], rows: [["a;b", "c"]] }, { csvDelimiter: ";" });
		expect(csv).toBe('A;B\r\n"a;b";c');
	});
	it("does not quote a comma when the delimiter is a tab", () => {
		expect(toCsv({ headers: ["A", "B"], rows: [["x,y", "z"]] }, { csvDelimiter: "\t" })).toBe(
			"A\tB\r\nx,y\tz",
		);
	});
	it("neutralizes formula-injection cells with a leading apostrophe", () => {
		const csv = toCsv({
			headers: ["A"],
			rows: [["=HYPERLINK(1)"], ["+1"], ["-1"], ["@x"], ["safe"]],
		});
		expect(csv).toBe("A\r\n'=HYPERLINK(1)\r\n'+1\r\n'-1\r\n'@x\r\nsafe");
	});
	it("composes formula-neutralization with delimiter quoting", () => {
		// leading "=" gets the guard apostrophe AND the embedded comma forces quoting
		expect(toCsv({ headers: ["A"], rows: [["=a,b"]] })).toBe('A\r\n"\'=a,b"');
	});
});

describe("toJson", () => {
	it("emits an array of header-keyed objects", () => {
		expect(JSON.parse(toJson(MATRIX))).toEqual([
			{ Name: "Buy milk", Status: "todo" },
			{ Name: "Ship it", Status: "done" },
		]);
	});
	it("pretty-prints by default and minifies when jsonPretty is false", () => {
		expect(toJson(MATRIX)).toContain("\n  ");
		const minified = toJson(MATRIX, { jsonPretty: false });
		expect(minified).not.toContain("\n");
		expect(JSON.parse(minified)).toHaveLength(2);
	});
});

describe("toMarkdown (GFM table)", () => {
	it("emits a header, divider, and one row per entry", () => {
		expect(toMarkdown(MATRIX)).toBe(
			"| Name | Status |\n| --- | --- |\n| Buy milk | todo |\n| Ship it | done |",
		);
	});
	it("escapes pipes and collapses newlines to <br>", () => {
		const md = toMarkdown({ headers: ["A"], rows: [["a|b"], ["x\ny"]] });
		expect(md).toContain("| a\\|b |");
		expect(md).toContain("| x<br>y |");
	});
});

describe("serializeList + extensionFor", () => {
	it("dispatches to the right serializer", () => {
		expect(serializeList(ListExportFormat.Csv, MATRIX)).toBe(toCsv(MATRIX));
		expect(serializeList(ListExportFormat.Json, MATRIX)).toBe(toJson(MATRIX));
		expect(serializeList(ListExportFormat.Markdown, MATRIX)).toBe(toMarkdown(MATRIX));
	});
	it("maps formats to file extensions", () => {
		expect(extensionFor(ListExportFormat.Csv)).toBe("csv");
		expect(extensionFor(ListExportFormat.Json)).toBe("json");
		expect(extensionFor(ListExportFormat.Markdown)).toBe("md");
	});
});

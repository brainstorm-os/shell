import { DateGranularity, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { planImport, runImport } from "./import-engine";
import { inferMapping, inferValueType } from "./import-map";
import { parseTable } from "./import-parse";
import { coerceToValueType, projectRecord } from "./import-project";
import {
	type EntityDraft,
	ImportFormat,
	type ImportWriteDeps,
	externalKeyOf,
} from "./import-types";

describe("import-parse", () => {
	it("parses a JSON array into records, columns in first-seen order", () => {
		const table = parseTable(ImportFormat.Json, '[{"a":1,"b":2},{"a":3,"c":4}]');
		expect(table.columns).toEqual(["a", "b", "c"]);
		expect(table.records).toHaveLength(2);
	});

	it("wraps a single JSON object as one row", () => {
		const table = parseTable(ImportFormat.Json, '{"a":1}');
		expect(table.records).toHaveLength(1);
	});

	it("parses JSONL one object per line and ignores blanks", () => {
		const table = parseTable(ImportFormat.Jsonl, '{"a":1}\n\n{"a":2}\n');
		expect(table.records).toHaveLength(2);
	});

	it("extracts a heuristic externalId from an id-like field", () => {
		const table = parseTable(ImportFormat.Json, '[{"uuid":"u1","x":1},{"x":2}]');
		expect(table.records[0]?.externalId).toBe("u1");
		expect(table.records[1]?.externalId).toBeNull();
	});

	it("drops non-object array elements", () => {
		const table = parseTable(ImportFormat.Json, '[{"a":1}, 7, null, "x"]');
		expect(table.records).toHaveLength(1);
	});

	it("parses CSV with a header row, quoted commas, and escaped quotes", () => {
		const csv = 'id,title,note\n1,"Hello, world","say ""hi"""\n2,Plain,ok\n';
		const table = parseTable(ImportFormat.Csv, csv);
		expect(table.columns).toEqual(["id", "title", "note"]);
		expect(table.records).toHaveLength(2);
		expect(table.records[0]?.fields).toEqual({ id: "1", title: "Hello, world", note: 'say "hi"' });
		expect(table.records[0]?.externalId).toBe("1");
	});

	it("parses CSV fields containing newlines inside quotes", () => {
		const csv = 'id,body\n1,"line one\nline two"\n';
		const table = parseTable(ImportFormat.Csv, csv);
		expect(table.records).toHaveLength(1);
		expect(table.records[0]?.fields.body).toBe("line one\nline two");
	});

	it("parses Markdown frontmatter into fields + body, with a title fallback", () => {
		const md = '---\ntitle: "My Note"\ntags: a\n---\nThe body text.\n';
		const table = parseTable(ImportFormat.Markdown, md, "fallback");
		expect(table.records).toHaveLength(1);
		expect(table.records[0]?.fields).toMatchObject({
			title: "My Note",
			tags: "a",
			body: "The body text.",
		});
		const noFm = parseTable(ImportFormat.Markdown, "just a body", "Daily");
		expect(noFm.records[0]?.fields).toMatchObject({ title: "Daily", body: "just a body" });
	});

	it("parses the first HTML table into rows (tags stripped, entities decoded)", () => {
		const html =
			"<table><tr><th>id</th><th>name</th></tr><tr><td>1</td><td>A &amp; B</td></tr></table>";
		const table = parseTable(ImportFormat.Html, html);
		expect(table.columns).toEqual(["id", "name"]);
		expect(table.records).toHaveLength(1);
		expect(table.records[0]?.fields).toEqual({ id: "1", name: "A & B" });
	});

	it("falls back to a single body record for table-less HTML", () => {
		const table = parseTable(ImportFormat.Html, "<p>hello <b>world</b></p>", "Doc");
		expect(table.records).toHaveLength(1);
		expect(table.records[0]?.fields).toMatchObject({ title: "Doc", body: "hello world" });
	});
});

describe("inferValueType", () => {
	it("infers boolean / number / text", () => {
		expect(inferValueType([true, false])).toBe(ValueType.Boolean);
		expect(inferValueType([1, 2, 3])).toBe(ValueType.Number);
		expect(inferValueType(["a", "b"])).toBe(ValueType.Text);
	});

	it("promotes ISO-ish date strings to Date, leaves bare numbers as Number", () => {
		expect(inferValueType(["2026-01-02", "2026-03-04"])).toBe(ValueType.Date);
		expect(inferValueType([1700000000, 1700000001])).toBe(ValueType.Number);
	});

	it("falls back to Text for empty or mixed columns", () => {
		expect(inferValueType([null, "", undefined])).toBe(ValueType.Text);
		expect(inferValueType([1, "two", true])).toBe(ValueType.Text);
	});
});

describe("inferMapping — map onto an existing type's PropertyDefs", () => {
	it("adopts a known property's ValueType over the sample-inferred guess", () => {
		const table = parseTable(ImportFormat.Json, '[{"due":"2026-01-02","note":"hi"}]');
		// "due" would infer Date from the sample; the existing type declares it Text.
		const known = new Map([
			["due", ValueType.Text],
			["unrelated", ValueType.Number],
		]);
		const mapping = inferMapping(table, "x/Task/v1", "json:t", known);
		const due = mapping.columns.find((c) => c.column === "due");
		const note = mapping.columns.find((c) => c.column === "note");
		expect(due?.valueType).toBe(ValueType.Text); // adopted from the known def
		expect(note?.valueType).toBe(ValueType.Text); // no known def → inferred
	});

	it("falls back to inference when no known def matches the column", () => {
		const table = parseTable(ImportFormat.Json, '[{"count":"3"}]');
		const mapping = inferMapping(table, "x/T/v1", "json:t", new Map());
		expect(mapping.columns[0]?.valueType).toBe(ValueType.Text);
	});
});

describe("coerceToValueType", () => {
	it("coerces external strings into typed shapes", () => {
		expect(coerceToValueType(ValueType.Number, "42")).toBe(42);
		expect(coerceToValueType(ValueType.Number, "nope")).toBeNull();
		expect(coerceToValueType(ValueType.Boolean, "yes")).toBe(true);
		expect(coerceToValueType(ValueType.Boolean, "0")).toBe(false);
		expect(coerceToValueType(ValueType.Text, 7)).toBe("7");
	});

	it("parses dates into { at, granularity }", () => {
		expect(coerceToValueType(ValueType.Date, "2026-01-02")).toEqual({
			at: Date.parse("2026-01-02"),
			granularity: DateGranularity.Date,
		});
		const dt = coerceToValueType(ValueType.Date, "2026-01-02T08:30") as {
			granularity: DateGranularity;
		};
		expect(dt.granularity).toBe(DateGranularity.DateTime);
		expect(coerceToValueType(ValueType.Date, "not-a-date")).toBeNull();
	});
});

describe("projectRecord", () => {
	it("projects mapped, included columns and skips absent ones", () => {
		const table = parseTable(ImportFormat.Json, '[{"title":"Hi","count":"3"}]');
		const mapping = inferMapping(table, "x/Note/v1", "json");
		// force count → Number (it parsed as a string column → Text by default)
		const tuned = {
			...mapping,
			columns: mapping.columns.map((c) =>
				c.column === "count" ? { ...c, valueType: ValueType.Number } : c,
			),
		};
		const record = table.records[0];
		if (!record) throw new Error("no record");
		const draft = projectRecord(record, tuned);
		expect(draft.type).toBe("x/Note/v1");
		expect(draft.properties).toEqual({ title: "Hi", count: 3 });
	});
});

/** In-memory write deps so the engine's create/update/dedupe logic is tested
 *  without a vault. */
function fakeDeps() {
	const rows = new Map<string, EntityDraft & { id: string }>();
	const byKey = new Map<string, string>();
	let n = 0;
	const deps: ImportWriteDeps = {
		findByExternalKey: (key) => byKey.get(key) ?? null,
		create: (draft, externalKey) => {
			const id = `e${++n}`;
			rows.set(id, { ...draft, id });
			if (externalKey) byKey.set(externalKey, id);
		},
		update: (id, properties) => {
			const cur = rows.get(id);
			if (cur) rows.set(id, { ...cur, properties: { ...cur.properties, ...properties } });
		},
	};
	return { deps, rows };
}

describe("import-engine plan/run idempotency", () => {
	const drafts: EntityDraft[] = [
		{ externalId: "1", type: "x/Note/v1", properties: { title: "A" } },
		{ externalId: "2", type: "x/Note/v1", properties: { title: "B" } },
		{ externalId: null, type: "x/Note/v1", properties: { title: "anon" } },
	];

	it("first run creates everything; re-run updates keyed rows, no duplicates", async () => {
		const { deps, rows } = fakeDeps();
		const first = await runImport(drafts, "json", deps, 1000);
		expect(first.created).toBe(3);
		expect(first.updated).toBe(0);
		expect(rows.size).toBe(3);

		// second run: the two keyed drafts upsert; the anon draft creates again
		const second = await runImport(drafts, "json", deps, 2000);
		expect(second.updated).toBe(2);
		expect(second.created).toBe(1);
		expect(rows.size).toBe(4); // only the anon row duplicated (no key)
		expect(externalKeyOf("json", "1")).toBe("json:1");
	});

	it("plan reports the same split run would take without writing", async () => {
		const { deps, rows } = fakeDeps();
		await runImport(drafts.slice(0, 1), "json", deps, 1000); // seed externalId "1"
		const plan = planImport(drafts, "json", deps);
		expect(plan.total).toBe(3);
		expect(plan.willUpdate).toBe(1); // "1" exists
		expect(plan.willCreate).toBe(2); // "2" + anon
		expect(rows.size).toBe(1); // plan wrote nothing
	});

	it("records a failing draft and continues", async () => {
		const deps: ImportWriteDeps = {
			findByExternalKey: () => null,
			create: (draft) => {
				if (draft.externalId === "boom") throw new Error("kaboom");
			},
			update: () => {},
		};
		const report = await runImport(
			[
				{ externalId: "boom", type: "x/Note/v1", properties: {} },
				{ externalId: "ok", type: "x/Note/v1", properties: {} },
			],
			"json",
			deps,
			1,
		);
		expect(report.created).toBe(1);
		expect(report.failed).toEqual([{ externalId: "boom", reason: "kaboom" }]);
	});

	it("streams progress and stops on an abort signal (remaining skipped)", async () => {
		const { deps, rows } = fakeDeps();
		const many: EntityDraft[] = Array.from({ length: 5 }, (_, n) => ({
			externalId: `e${n}`,
			type: "x/Note/v1",
			properties: { n },
		}));
		const ticks: Array<[number, number]> = [];
		const full = await runImport(many, "json", deps, 1, {
			onProgress: (done, total) => ticks.push([done, total]),
		});
		expect(full.created).toBe(5);
		expect(ticks.at(-1)).toEqual([5, 5]);

		// Abort before a fresh run: nothing commits, all skipped, cancelled flag set.
		const controller = new AbortController();
		controller.abort();
		const cancelled = await runImport(many, "json", fakeDeps().deps, 1, {
			signal: controller.signal,
		});
		expect(cancelled.created).toBe(0);
		expect(cancelled.skipped).toBe(5);
		expect(cancelled.cancelled).toBe(true);
		expect(rows.size).toBe(5); // the first run's rows, untouched by the aborted run
	});
});

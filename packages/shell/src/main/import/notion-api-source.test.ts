import { describe, expect, it, vi } from "vitest";
import { notionPageTitle, notionPropertyValue, planNotionApiImport } from "./notion-api-source";

describe("notionPropertyValue — one Notion property → a vault-shaped scalar", () => {
	const cases: Array<[string, unknown, unknown]> = [
		["title", { type: "title", title: [{ plain_text: "Ship it" }] }, "Ship it"],
		["rich_text", { type: "rich_text", rich_text: [{ plain_text: "a" }, { plain_text: "b" }] }, "ab"],
		["number", { type: "number", number: 42 }, 42],
		["checkbox", { type: "checkbox", checkbox: true }, true],
		["select", { type: "select", select: { name: "Done" } }, "Done"],
		["status", { type: "status", status: { name: "In progress" } }, "In progress"],
		["multi_select", { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] }, "a, b"],
		["date", { type: "date", date: { start: "2026-08-01" } }, "2026-08-01"],
		["url", { type: "url", url: "https://x.test" }, "https://x.test"],
		["email", { type: "email", email: "a@b.test" }, "a@b.test"],
		["phone_number", { type: "phone_number", phone_number: "+1 555" }, "+1 555"],
		["people", { type: "people", people: [{ name: "Mira" }, { name: "Sam" }] }, "Mira, Sam"],
		["files", { type: "files", files: [{ name: "spec.pdf" }] }, "spec.pdf"],
		[
			"created_time",
			{ type: "created_time", created_time: "2026-01-02T03:04:05Z" },
			"2026-01-02T03:04:05Z",
		],
		["unique_id", { type: "unique_id", unique_id: { prefix: "TASK", number: 7 } }, "TASK-7"],
		["formula(string)", { type: "formula", formula: { type: "string", string: "x" } }, "x"],
		["formula(number)", { type: "formula", formula: { type: "number", number: 3 } }, 3],
		["rollup(number)", { type: "rollup", rollup: { type: "number", number: 9 } }, 9],
	];

	for (const [name, property, expected] of cases) {
		it(`maps ${name}`, () => {
			expect(notionPropertyValue(property)).toEqual(expected);
		});
	}

	it("returns null for an empty or unreadable property (an empty cell, not a guess)", () => {
		expect(notionPropertyValue({ type: "select", select: null })).toBeNull();
		expect(notionPropertyValue({ type: "number", number: null })).toBeNull();
		expect(notionPropertyValue({ type: "relation", relation: [{ id: "x" }] })).toBeNull();
		expect(notionPropertyValue(undefined)).toBeNull();
	});

	it("clamps a hostile-length text value", () => {
		const long = { type: "rich_text", rich_text: [{ plain_text: "x".repeat(50_000) }] };
		expect(String(notionPropertyValue(long)).length).toBeLessThanOrEqual(10_000);
	});
});

describe("notionPageTitle", () => {
	it("reads the title property whatever it is named", () => {
		expect(
			notionPageTitle({
				id: "p1",
				properties: { Name: { type: "title", title: [{ plain_text: "Hello" }] } },
			}),
		).toBe("Hello");
		expect(
			notionPageTitle({
				id: "p1",
				properties: { Aufgabe: { type: "title", title: [{ plain_text: "Hallo" }] } },
			}),
		).toBe("Hallo");
	});

	it("falls back to a database object's own title, then to Untitled", () => {
		expect(notionPageTitle({ id: "d1", title: [{ plain_text: "Tasks" }] })).toBe("Tasks");
		expect(notionPageTitle({ id: "p1" })).toBe("Untitled");
	});
});

/** A workspace: one database with two rows, one standalone page. */
function stubWorkspace() {
	const database = {
		id: "db1",
		object: "database",
		title: [{ plain_text: "Tasks" }],
		properties: {
			Name: { type: "title" },
			Status: { type: "select" },
			Estimate: { type: "number" },
		},
	};
	const row = (id: string, name: string, status: string, estimate: number) => ({
		id,
		object: "page",
		parent: { type: "database_id", database_id: "db1" },
		properties: {
			Name: { type: "title", title: [{ plain_text: name }] },
			Status: { type: "select", select: { name: status } },
			Estimate: { type: "number", number: estimate },
		},
	});
	const standalone = {
		id: "pg1",
		object: "page",
		parent: { type: "workspace" },
		properties: { title: { type: "title", title: [{ plain_text: "Roadmap" }] } },
	};

	const transport = vi.fn(async (req: { method: string; path: string }) => {
		if (req.path === "/v1/search") {
			return { status: 200, json: { results: [database, standalone], has_more: false } };
		}
		if (req.path === "/v1/databases/db1") return { status: 200, json: database };
		if (req.path === "/v1/databases/db1/query") {
			return {
				status: 200,
				json: {
					results: [row("r1", "Ship it", "Doing", 3), row("r2", "Write docs", "Todo", 1)],
					has_more: false,
				},
			};
		}
		if (req.path.startsWith("/v1/blocks/pg1/children")) {
			return {
				status: 200,
				json: {
					results: [
						{ type: "heading_1", heading_1: { rich_text: [{ plain_text: "Q3" }] } },
						{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Ship the thing." }] } },
					],
					has_more: false,
				},
			};
		}
		if (req.path.startsWith("/v1/blocks/")) return { status: 200, json: { results: [] } };
		throw new Error(`unexpected path ${req.path}`);
	});
	return { transport };
}

describe("planNotionApiImport", () => {
	it("produces a draft per database row, tagged with its database", async () => {
		const plan = await planNotionApiImport(stubWorkspace().transport);
		const rows = plan.entities.filter((e) => e.database === "Tasks");
		expect(rows.map((r) => r.title)).toEqual(["Ship it", "Write docs"]);
		expect(rows[0]?.properties).toMatchObject({ Name: "Ship it", Status: "Doing", Estimate: 3 });
	});

	it("renders a standalone page's blocks into the importer's markdown body", async () => {
		const plan = await planNotionApiImport(stubWorkspace().transport);
		const page = plan.entities.find((e) => e.title === "Roadmap");
		expect(page?.database).toBeNull();
		expect(page?.properties.body).toBe("# Q3\n\nShip the thing.");
	});

	it("keys every draft by its Notion id so re-import updates instead of duplicating", async () => {
		const plan = await planNotionApiImport(stubWorkspace().transport);
		expect(plan.entities.map((e) => e.externalId).sort()).toEqual([
			"notion:pg1",
			"notion:r1",
			"notion:r2",
		]);
	});

	it("links a database row to its database's page when both are in the set", async () => {
		const plan = await planNotionApiImport(stubWorkspace().transport);
		// The database itself isn't imported as a page, so a row has no parent
		// link to resolve — links stay empty rather than dangling.
		expect(plan.links).toEqual([]);
		expect(plan.unresolved).toEqual([]);
	});

	it("skips archived pages", async () => {
		const transport = vi.fn(async (req: { path: string }) => {
			if (req.path === "/v1/search") {
				return {
					status: 200,
					json: {
						results: [
							{ id: "p1", object: "page", archived: true, parent: { type: "workspace" } },
							{
								id: "p2",
								object: "page",
								parent: { type: "workspace" },
								properties: { title: { type: "title", title: [{ plain_text: "Live" }] } },
							},
						],
						has_more: false,
					},
				};
			}
			return { status: 200, json: { results: [] } };
		});
		const plan = await planNotionApiImport(transport);
		expect(plan.entities.map((e) => e.title)).toEqual(["Live"]);
	});

	it("degrades to a body-less page when its block fetch fails", async () => {
		const transport = vi.fn(async (req: { path: string }) => {
			if (req.path === "/v1/search") {
				return {
					status: 200,
					json: {
						results: [
							{
								id: "p1",
								object: "page",
								parent: { type: "workspace" },
								properties: { title: { type: "title", title: [{ plain_text: "Solo" }] } },
							},
						],
						has_more: false,
					},
				};
			}
			return { status: 500, json: { message: "boom" } };
		});
		const plan = await planNotionApiImport(transport);
		expect(plan.entities).toHaveLength(1);
		expect(plan.entities[0]?.properties.body).toBeUndefined();
	});

	it("reports progress as it walks the workspace", async () => {
		const seen: string[] = [];
		await planNotionApiImport(stubWorkspace().transport, {
			onProgress: (stage) => seen.push(stage),
		});
		expect(seen[0]).toBe("search");
		expect(seen).toContain("databases");
		expect(seen).toContain("pages");
	});

	it("propagates an auth failure from the very first call (nothing to import)", async () => {
		const transport = vi.fn(async () => ({ status: 401, json: { message: "unauthorized" } }));
		await expect(planNotionApiImport(transport)).rejects.toMatchObject({ status: 401 });
	});
});

describe("notionPropertyValue — computed (formula / rollup) values", () => {
	it("reads a rollup array by flattening its members", () => {
		expect(
			notionPropertyValue({
				type: "rollup",
				rollup: {
					type: "array",
					array: [
						{ type: "select", select: { name: "a" } },
						{ type: "number", number: 2 },
					],
				},
			}),
		).toBe("a, 2");
	});

	it("reads a formula date and a formula boolean", () => {
		expect(
			notionPropertyValue({
				type: "formula",
				formula: { type: "date", date: { start: "2026-08-01" } },
			}),
		).toBe("2026-08-01");
		expect(
			notionPropertyValue({ type: "formula", formula: { type: "boolean", boolean: false } }),
		).toBe(false);
	});

	it("returns null for a computed value of an unknown shape", () => {
		expect(notionPropertyValue({ type: "formula", formula: { type: "mystery" } })).toBeNull();
	});
});

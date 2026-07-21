import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "@brainstorm-os/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../storage/migrations";
import { SEARCH_MIGRATIONS } from "../storage/search-schema";
import { collectIndexableEntities } from "./collect-indexable";
import { SearchIndexer } from "./search-indexer";

describe("collectIndexableEntities", () => {
	let vault: string;

	beforeEach(async () => {
		vault = await mkdtemp(join(tmpdir(), "brainstorm-search-"));
	});
	afterEach(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	it("returns [] when given a null vault path", async () => {
		expect(await collectIndexableEntities(null)).toEqual([]);
	});

	it("returns [] when there is no repo (no active session)", async () => {
		expect(await collectIndexableEntities(vault)).toEqual([]);
	});

	// entities.db is the sole source; every first-party app writes there,
	// so cross-app search covers them all uniformly.
	type Row = {
		id: string;
		type: string;
		properties: Record<string, unknown>;
		createdBy: string;
		createdAt: number;
		updatedAt: number;
	};
	const row = (id: string, type: string, properties: Record<string, unknown>): Row => ({
		id,
		type,
		properties,
		createdBy: "io.brainstorm.shell",
		createdAt: 0,
		updatedAt: 0,
	});
	const repoOf =
		(rows: Row[], opts: { queryThrows?: boolean } = {}) =>
		async () => ({
			query: (_q: Record<string, never>) => {
				if (opts.queryThrows) throw new Error("db hiccup");
				return rows;
			},
			linksFrom: (_id: string) => [],
		});

	it("indexes entities.db rows of any type — title from title|name, body from rich body + string props", async () => {
		const repo = repoOf([
			row("t1", "io.brainstorm.tasks/Task/v1", {
				title: "Ship 9.22.5",
				status: "in-progress",
				description: "broaden the indexer past notes",
				estimateHours: 4, // non-string — not folded into body
			}),
			row("b1", "io.brainstorm.bookmarks/Bookmark/v1", {
				name: "Brainstorm repo",
				url: "https://example.com/brainstorm",
			}),
			row("n1", "io.brainstorm.notes/Note/v1", {
				title: "A note",
				body: { root: { children: [{ children: [{ type: "text", text: "rich body" }] }] } },
			}),
		]);
		const out = await collectIndexableEntities(vault, repo);
		const byId = new Map(out.map((e) => [e.entityId, e]));
		expect(byId.get("t1")).toMatchObject({
			type: "io.brainstorm.tasks/Task/v1",
			title: "Ship 9.22.5",
		});
		// status + description folded in; the numeric estimate is not.
		expect(byId.get("t1")?.body).toContain("broaden the indexer past notes");
		expect(byId.get("t1")?.body).toContain("in-progress");
		expect(byId.get("t1")?.body).not.toContain("4");
		expect(byId.get("b1")).toMatchObject({ title: "Brainstorm repo" });
		expect(byId.get("b1")?.body).toContain("https://example.com/brainstorm");
		expect(byId.get("n1")?.body).toBe("rich body");
	});

	it("folds string leaves of arrays and nested objects into the body — without JSON noise", async () => {
		const repo = repoOf([
			row("e1", "io.x/T/v1", {
				title: "obj props",
				meta: { nested: "wrapped-value", weight: 7 },
				tags: ["founder", "ops"],
				assignees: [{ name: "Mira" }],
			}),
		]);
		const [e] = await collectIndexableEntities(vault, repo);
		// tags (string array), `{ value }`-style wrappers, and strings inside
		// arrays of objects are all reachable…
		expect(e?.body).toContain("founder");
		expect(e?.body).toContain("ops");
		expect(e?.body).toContain("wrapped-value");
		expect(e?.body).toContain("Mira");
		// …but never via JSON.stringify: no key names, braces, or numbers.
		expect(e?.body).not.toContain("nested");
		expect(e?.body).not.toContain("{");
		expect(e?.body).not.toContain("7");
	});

	it("stops walking property values past the depth cap", async () => {
		const repo = repoOf([
			row("e1", "io.x/T/v1", {
				title: "deep",
				ok: { a: "reachable" },
				deep: { a: { b: { c: { d: { e: "buried-too-deep" } } } } },
			}),
		]);
		const [e] = await collectIndexableEntities(vault, repo);
		expect(e?.body).toContain("reachable");
		expect(e?.body).not.toContain("buried-too-deep");
	});

	it("clamps an oversized flat body to the cap", async () => {
		const huge = "x".repeat(100_001);
		const repo = repoOf([row("e1", "io.x/T/v1", { title: "big", description: huge })]);
		const [e] = await collectIndexableEntities(vault, repo);
		expect(e?.body.length).toBe(100_000);
	});

	it("skips an entities.db row with blank title AND body", async () => {
		const repo = repoOf([
			row("blank", "io.x/T/v1", { title: "", note: "   " }),
			row("kept", "io.x/T/v1", { title: "kept" }),
		]);
		const out = await collectIndexableEntities(vault, repo);
		expect(out.map((e) => e.entityId)).toEqual(["kept"]);
	});

	it("does not index structural child types (WhiteboardEdge)", async () => {
		const repo = repoOf([
			row("wb1", "brainstorm/Whiteboard/v1", { name: "Board" }),
			row("edge1", "brainstorm/WhiteboardEdge/v1", {
				whiteboardId: "wb1",
				label: "depends on",
			}),
		]);
		const out = await collectIndexableEntities(vault, repo);
		expect(out.map((e) => e.entityId)).toEqual(["wb1"]);
	});

	it("a throwing getEntitiesRepo degrades to []", async () => {
		const out = await collectIndexableEntities(vault, async () => {
			throw new Error("repo open failed");
		});
		expect(out).toEqual([]);
	});

	it("a repo whose query() throws degrades to []", async () => {
		const out = await collectIndexableEntities(vault, repoOf([], { queryThrows: true }));
		expect(out).toEqual([]);
	});

	it("a null repo (no active session) yields []", async () => {
		const out = await collectIndexableEntities(vault, async () => null);
		expect(out).toEqual([]);
	});

	// End-to-end exit criterion: the user's original report — "I did not
	// see full-text cross-app search in the tasks". A Task in entities.db
	// must now surface through the same collect → rebuild → query path
	// the live shell uses.
	it("a Task written to entities.db is searchable end-to-end (collect → rebuild → query)", async () => {
		const repo = repoOf([
			row("task-1", "io.brainstorm.tasks/Task/v1", {
				title: "Renew SSL certificate",
				description: "before the staging cluster expiry",
			}),
		]);
		const entities = await collectIndexableEntities(vault, repo);

		const db = await open(":memory:");
		await applyMigrations(db, SEARCH_MIGRATIONS);
		const indexer = new SearchIndexer(db);
		try {
			indexer.rebuild(entities);
			const byTitle = indexer.query({ text: "certificate" });
			expect(byTitle.map((h) => h.entityId)).toEqual(["task-1"]);
			expect(byTitle[0]?.type).toBe("io.brainstorm.tasks/Task/v1");
			// folded-in description property is searchable too
			const byDesc = indexer.query({ text: "staging cluster" });
			expect(byDesc.map((h) => h.entityId)).toEqual(["task-1"]);
			// type filter still scopes correctly to the Task type
			const scoped = indexer.query({
				text: "certificate",
				types: ["io.brainstorm.tasks/Task/v1"],
			});
			expect(scoped).toHaveLength(1);
		} finally {
			db.close();
		}
	});
});

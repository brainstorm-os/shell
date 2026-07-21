/**
 * IE-6 Notion importer. The pure `parseNotionExport` + its helpers are tested
 * directly; the `importNotionExport` vault binding runs against a real session
 * (Electron mocked) so idempotent upsert + link rebuild are proven end-to-end.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let USER_DATA_DIR = "";
vi.mock("electron", () => ({ app: { getPath: () => USER_DATA_DIR } }));

import { LIST_ENTITY_TYPE } from "@brainstorm-os/sdk";
import { ValueType } from "@brainstorm-os/sdk-types";
import { __setSqlcipherDriverForTests } from "@brainstorm-os/sqlite";
import { __resetAtRestProbeForTests } from "@brainstorm-os/sqlite/at-rest-mode";
import { EntitiesRepository } from "../storage/entities-repo";
import { closeActiveVaultSession, getActiveVaultSession } from "../vault/session";
import { createVault } from "../vault/vault";
import {
	type NotionFile,
	NotionLinkKind,
	deriveDatabaseSchemas,
	importNotionExport,
	notionCollectionId,
	parseNotionExport,
	parseNotionPage,
	resolveNotionPath,
	stripNotionId,
} from "./notion-import";

const PROJ = "0123456789abcdef0123456789abcdef";
const ROAD = "11111111111111111111111111111111";
const TASKS = "22222222222222222222222222222222";
const SOLO = "33333333333333333333333333333333";

const FILES: NotionFile[] = [
	{
		path: `Projects ${PROJ}.md`,
		text: `# Projects\n\nOur work.\n\nSee [Roadmap](Projects%20${PROJ}/Roadmap%20${ROAD}.md)\n`,
	},
	{
		path: `Projects ${PROJ}/Roadmap ${ROAD}.md`,
		text: "# Roadmap\n\nMilestones live here.\n",
	},
	{
		path: `Standalone ${SOLO}.md`,
		text: "# Standalone\n\nStatus: Active\nOwner: Me\n\nThe actual content here.\n",
	},
	{
		path: `Tasks ${TASKS}.csv`,
		text: "Name,Status,Priority\nShip it,Done,High\nTest it,In progress,Medium\n",
	},
];

describe("stripNotionId", () => {
	it("drops the trailing 32-hex id + extension", () => {
		expect(stripNotionId(`Tasks ${TASKS}.csv`)).toBe("Tasks");
		expect(stripNotionId(`dir/My Page ${PROJ}.md`)).toBe("My Page");
	});
	it("folds the _all CSV variant onto the database name", () => {
		expect(stripNotionId(`Roadmap ${ROAD}_all.csv`)).toBe("Roadmap");
	});
});

describe("resolveNotionPath", () => {
	it("resolves a relative URL-encoded path against the page dir", () => {
		expect(resolveNotionPath(`Projects ${PROJ}`, `Projects%20${PROJ}/Roadmap%20${ROAD}.md`)).toBe(
			`Projects ${PROJ}/Projects ${PROJ}/Roadmap ${ROAD}.md`,
		);
		expect(resolveNotionPath("a/b", "../Other%2044444444444444444444444444444444.md")).toBe(
			"a/Other 44444444444444444444444444444444.md",
		);
	});
	it("rejects external / absolute / anchor-only urls", () => {
		expect(resolveNotionPath("", "https://example.com")).toBeNull();
		expect(resolveNotionPath("", "mailto:x@y.z")).toBeNull();
		expect(resolveNotionPath("a", "/abs/path.md")).toBeNull();
		expect(resolveNotionPath("a", "#anchor")).toBeNull();
	});
});

describe("parseNotionPage", () => {
	it("extracts the H1 title, the property block, and the body after it", () => {
		const { title, properties, body } = parseNotionPage(
			"# Standalone\n\nStatus: Active\nOwner: Me\n\nThe actual content here.\n",
			"fallback",
		);
		expect(title).toBe("Standalone");
		expect(properties).toEqual({ Status: "Active", Owner: "Me" });
		expect(body).toBe("The actual content here.");
	});
	it("keeps the whole content as body when there is no property block", () => {
		const { title, properties, body } = parseNotionPage(
			"# Notes\n\nJust prose, no props.\n",
			"fallback",
		);
		expect(title).toBe("Notes");
		expect(properties).toEqual({});
		expect(body).toBe("Just prose, no props.");
	});
	it("falls back to the supplied title when there is no H1", () => {
		const { title } = parseNotionPage("plain text\n", "From Filename");
		expect(title).toBe("From Filename");
	});
});

describe("parseNotionExport (pure)", () => {
	it("maps pages + database rows to entity drafts", () => {
		const plan = parseNotionExport(FILES);
		// 3 markdown pages + 2 CSV rows.
		expect(plan.entities).toHaveLength(5);
		const projects = plan.entities.find((e) => e.title === "Projects");
		expect(projects?.properties.body).toContain("Our work.");
		const standalone = plan.entities.find((e) => e.title === "Standalone");
		expect(standalone?.properties.Status).toBe("Active");
		const ship = plan.entities.find((e) => e.title === "Ship it");
		expect(ship?.database).toBe("Tasks");
		expect(ship?.properties.notionDatabase).toBe("Tasks");
		expect(ship?.properties.Priority).toBe("High");
		expect(ship?.externalId).toBe(`Tasks ${TASKS}.csv#1`); // keyed on row position
	});

	it("keeps database rows with duplicate titles distinct (no dedupe collision)", () => {
		const dup: NotionFile[] = [
			{ path: `Tasks ${TASKS}.csv`, text: "Name,Status\nDo it,Open\nDo it,Done\n" },
		];
		const plan = parseNotionExport(dup);
		expect(plan.entities).toHaveLength(2);
		expect(new Set(plan.entities.map((e) => e.externalId)).size).toBe(2);
	});

	it("derives the page-tree parent relation from the sibling-folder convention", () => {
		const plan = parseNotionExport(FILES);
		expect(plan.links).toContainEqual({
			from: `Projects ${PROJ}/Roadmap ${ROAD}.md`,
			to: `Projects ${PROJ}.md`,
			kind: NotionLinkKind.Parent,
		});
	});

	it("resolves an internal markdown link to a reference", () => {
		const plan = parseNotionExport(FILES);
		expect(plan.links).toContainEqual({
			from: `Projects ${PROJ}.md`,
			to: `Projects ${PROJ}/Roadmap ${ROAD}.md`,
			kind: NotionLinkKind.Reference,
		});
	});

	it("prefers the _all.csv variant so a database imports once", () => {
		const both: NotionFile[] = [
			{ path: `Tasks ${TASKS}.csv`, text: "Name\nFiltered\n" },
			{ path: `Tasks ${TASKS}_all.csv`, text: "Name\nA\nB\n" },
		];
		const plan = parseNotionExport(both);
		expect(plan.entities.map((e) => e.title).sort()).toEqual(["A", "B"]);
	});

	it("surfaces a markdown link to a missing page as unresolved", () => {
		const files: NotionFile[] = [{ path: "Note abc.md", text: "Gone: [x](Missing%20deadbeef.md)\n" }];
		const plan = parseNotionExport(files);
		expect(plan.unresolved).toContainEqual({ from: "Note abc.md", target: "Missing deadbeef.md" });
	});

	it("resolves a markdown link to an attachment file", () => {
		const files: NotionFile[] = [{ path: "Spec abc.md", text: "Diagram: [wire](assets/wire.png)\n" }];
		const plan = parseNotionExport(files, ["assets/wire.png"]);
		expect(plan.attachmentLinks).toEqual([
			{ fromPage: "Spec abc.md", attachmentPath: "assets/wire.png" },
		]);
		expect(plan.referencedAttachments).toEqual(["assets/wire.png"]);
	});
});

describe("deriveDatabaseSchemas (IE-2 Map tail, pure)", () => {
	it("derives one typed schema per database from its columns", () => {
		const plan = parseNotionExport(FILES);
		const schemas = deriveDatabaseSchemas(plan);
		expect(schemas).toHaveLength(1);
		const tasks = schemas[0];
		expect(tasks?.database).toBe("Tasks");
		expect(tasks?.properties.map((p) => p.key)).toEqual(["name", "status", "priority"]);
		// All-string columns infer to Text.
		expect(tasks?.properties.every((p) => p.valueType === ValueType.Text)).toBe(true);
	});

	it("promotes ISO-date columns to Date; CSV numeric strings stay Text (conservative)", () => {
		const plan = parseNotionExport([
			{ path: `Metrics ${TASKS}.csv`, text: "Name,Count,Due\nA,3,2026-01-02\nB,7,2026-03-04\n" },
		]);
		const [schema] = deriveDatabaseSchemas(plan);
		const byKey = new Map(schema?.properties.map((p) => [p.key, p.valueType]));
		// CSV values are always strings; only ISO-ish strings promote (IE-2's
		// conservative inference — a bare numeric string stays re-mappable Text).
		expect(byKey.get("count")).toBe(ValueType.Text);
		expect(byKey.get("due")).toBe(ValueType.Date);
	});

	it("returns no schema for a markdown-only export (no databases)", () => {
		const plan = parseNotionExport([{ path: "Note abc.md", text: "# Note\n\nBody.\n" }]);
		expect(deriveDatabaseSchemas(plan)).toEqual([]);
	});
});

describe("importNotionExport (vault binding)", () => {
	let workDir = "";

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "bs-notion-"));
		USER_DATA_DIR = workDir;
		__setSqlcipherDriverForTests(null);
		__resetAtRestProbeForTests();
		await createVault({
			name: "NX",
			path: join(workDir, "vault"),
			keystore: { forceInsecure: true },
			seedStarterContent: false,
		});
	});

	afterEach(async () => {
		closeActiveVaultSession();
		await rm(workDir, { recursive: true, force: true });
	});

	const opts = {
		targetType: "test/Note/v1",
		source: "notion:v1",
		now: 1_700_000_000_000,
		importedBy: "shell:import",
	};

	it("creates pages + rows + links, then re-imports idempotently", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");

		const first = await importNotionExport(session, FILES, opts);
		expect(first.created).toBe(5);
		expect(first.updated).toBe(0);
		// Projects→Roadmap reference + Roadmap→Projects parent.
		expect(first.linked).toBe(2);
		expect(first.unresolved).toBe(0);

		const repo = new EntitiesRepository(await session.dataStores.open("entities"));
		const ids = repo.query({ type: ["test/Note/v1"] }).map((e) => e.id);
		expect(ids).toHaveLength(5);
		expect(repo.linksFromMany(ids)).toHaveLength(2);

		const second = await importNotionExport(session, FILES, opts);
		expect(second.created).toBe(0);
		expect(second.updated).toBe(5);
		const ids2 = repo.query({ type: ["test/Note/v1"] }).map((e) => e.id);
		expect(ids2).toHaveLength(5); // no duplicate entities
		expect(repo.linksFromMany(ids2)).toHaveLength(2); // no duplicate links
	});

	it("mints a typed List/v1 collection + PropertyDefs per database, idempotently", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");

		const first = await importNotionExport(session, FILES, opts);
		expect(first.collectionsCreated).toBe(1);
		expect(first.propertiesRegistered).toBe(3); // Name, Status, Priority

		// The collection is a real List/v1 entity grouping the database's 2 rows.
		const repo = new EntitiesRepository(await session.dataStores.open("entities"));
		const lists = repo.query({ type: [LIST_ENTITY_TYPE] });
		expect(lists).toHaveLength(1);
		expect(lists[0]?.id).toBe(notionCollectionId(opts.source, "Tasks"));

		// Columns landed in the vault property catalog as typed PropertyDefs.
		const store = await session.propertiesStore();
		const keys = Object.keys(store.snapshot().properties);
		expect(keys).toEqual(expect.arrayContaining(["name", "status", "priority"]));

		// Re-import updates the same collection — no duplicate List entity.
		const second = await importNotionExport(session, FILES, opts);
		expect(second.collectionsCreated).toBe(1);
		expect(repo.query({ type: [LIST_ENTITY_TYPE] })).toHaveLength(1);
	});

	it("streams page progress and cancels on an aborted signal", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");
		const ticks: Array<[number, number]> = [];
		const report = await importNotionExport(session, FILES, {
			...opts,
			source: "notion:prog",
			onProgress: (done, total) => ticks.push([done, total]),
		});
		expect(report.created).toBe(5); // 3 pages + 2 database rows
		expect(ticks.at(-1)).toEqual([5, 5]);

		const controller = new AbortController();
		controller.abort();
		const cancelled = await importNotionExport(session, FILES, {
			...opts,
			source: "notion:cancel",
			signal: controller.signal,
		});
		expect(cancelled.created).toBe(0);
		expect(cancelled.cancelled).toBe(true);
	});

	it("imports a referenced attachment as a File/v1 linked from the page", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");
		const files: NotionFile[] = [{ path: "Spec abc.md", text: "Layout: [wire](assets/wire.png)\n" }];
		const attachments = [{ path: "assets/wire.png", bytes: new Uint8Array([1, 2, 3, 4]) }];

		const report = await importNotionExport(
			session,
			files,
			{ ...opts, source: "notion:att" },
			attachments,
		);
		expect(report.filesCreated).toBe(1);
		expect(report.linked).toBe(1);

		const repo = new EntitiesRepository(await session.dataStores.open("entities"));
		const file = repo
			.query({ type: ["brainstorm/File/v1"] })
			.find((e) => e.properties.name === "wire.png");
		expect(file?.properties.mime).toBe("image/png");
		expect(file?.properties.attachment).toBe(`brainstorm://asset/${file?.properties.assetId}`);

		// Re-import: no duplicate File/v1, no duplicate link.
		await importNotionExport(session, files, { ...opts, source: "notion:att" }, attachments);
		expect(repo.query({ type: ["brainstorm/File/v1"] })).toHaveLength(1);
	});
});

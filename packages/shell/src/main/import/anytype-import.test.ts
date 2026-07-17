/**
 * IE-7 Anytype importer. The pure `parseAnytypeExport` + helpers are tested
 * directly against synthetic pb.json snapshots (modelled on Anytype's
 * `Export → Any-Block (JSON)` shape); the `importAnytypeExport` vault binding
 * runs against a real session (Electron mocked) so idempotent upsert + link
 * rebuild are proven end-to-end, mirroring the Notion suite.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let USER_DATA_DIR = "";
vi.mock("electron", () => ({ app: { getPath: () => USER_DATA_DIR } }));

import { LIST_ENTITY_TYPE } from "@brainstorm/sdk";
import { ValueType } from "@brainstorm/sdk-types";
import { __resetAtRestProbeForTests } from "../storage/at-rest-mode";
import { EntitiesRepository } from "../storage/entities-repo";
import { __setSqlcipherDriverForTests } from "../storage/sqlite";
import { closeActiveVaultSession, getActiveVaultSession } from "../vault/session";
import { createVault } from "../vault/vault";
import {
	type AnytypeFile,
	anytypeCollectionId,
	deriveTypeSchemas,
	importAnytypeExport,
	parseAnytypeExport,
	renderTextRun,
} from "./anytype-import";

function snapshotFile(id: string, sbType: string, data: Record<string, unknown>): AnytypeFile {
	const details = { id, ...(data.details as Record<string, unknown> | undefined) };
	return {
		path: `${id}.pb.json`,
		text: JSON.stringify({ sbType, snapshot: { data: { ...data, details } } }),
	};
}

const text = (
	id: string,
	body: string,
	style?: string,
	extra?: Record<string, unknown>,
	children?: string[],
) => ({
	id,
	...(children ? { childrenIds: children } : {}),
	text: { text: body, ...(style ? { style } : {}), ...(extra ?? {}) },
});

const FILES: AnytypeFile[] = [
	// Schema objects — consumed for names, never imported.
	snapshotFile("t-page", "STType", { details: { name: "Seite" }, key: "page" }),
	snapshotFile("t-task", "STType", { details: { name: "Task", uniqueKey: "ot-task" } }),
	snapshotFile("rel-effort", "STRelation", {
		details: { name: "Effort", relationKey: "bafyeffortkey" },
	}),
	snapshotFile("rel-due", "STRelation", {
		details: { name: "Due date", relationKey: "dueDate", relationFormat: 4 },
	}),
	snapshotFile("rel-owner", "STRelation", {
		details: { name: "Owner", relationKey: "bafyownerkey", relationFormat: 100 },
	}),
	snapshotFile("opt-urgent", "STRelationOption", { details: { name: "Urgent" } }),
	// Real exports name file objects WITHOUT the extension; fileExt is separate.
	snapshotFile("file-1", "FileObject", { details: { name: "diagram", fileExt: "png" } }),
	snapshotFile("file-2", "FileObject", { details: { name: "missing.bin" } }),

	// A page exercising blocks, marks, mentions, links, files, bookmarks.
	snapshotFile("obj-a", "Page", {
		objectTypes: ["ot-page"],
		details: {
			name: "Project Phoenix",
			description: "Rebuild everything",
			tag: ["opt-urgent", "opt-ghost"],
			bafyeffortkey: 5,
			bafyownerkey: "obj-b",
			syncError: 3,
			isArchived: false,
		},
		blocks: [
			{
				id: "obj-a",
				childrenIds: ["header", "b1", "b2", "b3", "b4", "b6", "b7", "b8", "b9", "b10", "b11"],
			},
			{ id: "header", childrenIds: ["title"] },
			text("title", "Project Phoenix", "Title"),
			text("b1", "bold and linked", "Paragraph", {
				marks: {
					marks: [
						{ range: { from: 0, to: 4 }, type: "Bold" },
						{ range: { from: 9, to: 15 }, type: "Link", param: "https://example.com" },
					],
				},
			}),
			text("b2", "Milestones", "Header2"),
			text("b3", "Ship it", "Checkbox", { checked: true }),
			text("b4", "Parent item", "Marked", {}, ["b5"]),
			text("b5", "Nested item", "Marked"),
			text("b6", "see the task", "Paragraph", {
				marks: { marks: [{ range: { from: 4, to: 12 }, type: "Mention", param: "obj-b" }] },
			}),
			{ id: "b7", link: { targetBlockId: "obj-b" } },
			{ id: "b8", file: { targetObjectId: "file-1", name: "diagram.png", type: "Image" } },
			{ id: "b9", bookmark: { url: "https://anytype.io", title: "Anytype" } },
			{ id: "b10", file: { targetObjectId: "file-2" } },
			{ id: "b11", div: { style: "Line" } },
		],
	}),

	// A task typed by the schema object above.
	snapshotFile("obj-b", "Page", {
		objectTypes: ["ot-task"],
		details: { name: "Ship importer", done: true, dueDate: 1774254674 },
		blocks: [
			{ id: "obj-b", childrenIds: ["c1"] },
			text("c1", "mention a ghost", "Paragraph", {
				marks: { marks: [{ range: { from: 0, to: 7 }, type: "Object", param: "obj-ghost" }] },
			}),
		],
	}),

	// A template — space chrome, skipped by its objectTypes.
	snapshotFile("obj-t", "Page", {
		objectTypes: ["ot-template", "ot-task"],
		details: { name: "Task template" },
	}),

	// Archived — skipped entirely.
	snapshotFile("obj-c", "Page", { details: { name: "Old plan", isArchived: true } }),

	// A Collection with one member missing from the export.
	snapshotFile("obj-col", "Page", {
		objectTypes: ["ot-collection"],
		details: { name: "Reading list" },
		collections: { objects: ["obj-a", "obj-b", "obj-missing"] },
	}),

	// Corrupt JSON — skipped, never fatal.
	{ path: "broken.pb.json", text: "{not json" },
];

const ATTACHMENTS = ["files/diagram.png"];

describe("renderTextRun", () => {
	it("applies non-overlapping marks and renders links", () => {
		const out = renderTextRun(
			"bold and linked",
			[
				{ from: 0, to: 4, type: "Bold", param: "" },
				{ from: 9, to: 15, type: "Link", param: "https://example.com" },
			],
			() => {},
		);
		expect(out).toBe("**bold** and [linked](https://example.com)");
	});

	it("keeps the first of two overlapping marks", () => {
		const out = renderTextRun(
			"overlap",
			[
				{ from: 0, to: 5, type: "Bold", param: "" },
				{ from: 3, to: 7, type: "Italic", param: "" },
			],
			() => {},
		);
		expect(out).toBe("**overl**ap");
	});

	it("reports mentions without altering the text", () => {
		const mentions: string[] = [];
		const out = renderTextRun(
			"see the task",
			[{ from: 4, to: 12, type: "Mention", param: "obj-b" }],
			(t) => mentions.push(t),
		);
		expect(out).toBe("see the task");
		expect(mentions).toEqual(["obj-b"]);
	});

	it("ignores marks outside the text bounds", () => {
		expect(renderTextRun("hi", [{ from: 0, to: 99, type: "Bold", param: "" }], () => {})).toBe("hi");
	});
});

describe("parseAnytypeExport", () => {
	const plan = parseAnytypeExport(FILES, ATTACHMENTS);

	it("imports objects, skips schema/system/archived snapshots", () => {
		expect(plan.entities.map((e) => e.externalId).sort()).toEqual(["obj-a", "obj-b", "obj-col"]);
		expect(plan.skippedArchived).toBe(1);
		expect(plan.skippedSystem).toBe(1);
	});

	it("resolves type names, relation names, and option labels", () => {
		const a = plan.entities.find((e) => e.externalId === "obj-a");
		// "ot-page" resolves through the STType's data.key, not name-prettifying.
		expect(a?.anytypeType).toBe("Seite");
		expect(a?.properties.syncError).toBeUndefined();
		expect(a?.properties.Effort).toBe(5);
		// Known option resolves to its label; an unknown id passes through.
		expect(a?.properties.tag).toEqual(["Urgent", "opt-ghost"]);
		expect(a?.properties.description).toBe("Rebuild everything");
		const b = plan.entities.find((e) => e.externalId === "obj-b");
		expect(b?.anytypeType).toBe("Task");
		expect(b?.properties.done).toBe(true);
	});

	it("converts values by relation format: dates → ISO, object refs → names", () => {
		const b = plan.entities.find((e) => e.externalId === "obj-b");
		expect(b?.properties["Due date"]).toBe(new Date(1774254674 * 1000).toISOString());
		const a = plan.entities.find((e) => e.externalId === "obj-a");
		expect(a?.properties.Owner).toBe("Ship importer");
	});

	it("renders the block tree to markdown, skipping chrome blocks", () => {
		const body = String(plan.entities.find((e) => e.externalId === "obj-a")?.properties.body);
		expect(body).toContain("**bold** and [linked](https://example.com)");
		expect(body).toContain("## Milestones");
		expect(body).toContain("- [x] Ship it");
		expect(body).toContain("- Parent item\n  - Nested item");
		expect(body).toContain("[Anytype](https://anytype.io)");
		expect(body).toContain("---");
		// File blocks leave an inline trace (image syntax for images).
		expect(body).toContain("![diagram.png](diagram.png)");
		// The Title chrome block is details-borne, not body content.
		expect(body).not.toContain("Project Phoenix");
	});

	it("collects the link graph: mention + link block collapse to one edge", () => {
		expect(plan.links).toEqual([{ from: "obj-a", to: "obj-b" }]);
		expect(plan.fileLinks).toEqual([{ fromObject: "obj-a", fileObjectId: "file-1" }]);
		expect(plan.fileBinaryByObject.get("file-1")).toBe("files/diagram.png");
		expect(plan.unresolved).toEqual([{ from: "obj-b", target: "obj-ghost" }]);
		// A known file object with no binary in the export is counted, not dangling.
		expect(plan.filesMissingBinary).toBe(1);
	});

	it("keeps Collection membership filtered to exported objects", () => {
		expect(plan.collections).toEqual([
			{ id: "obj-col", name: "Reading list", memberIds: ["obj-a", "obj-b"] },
		]);
	});

	it("matches a file block to a binary by its inline name when the object index misses", () => {
		const loose = parseAnytypeExport(
			[
				snapshotFile("obj-l", "Page", {
					details: { name: "Loose" },
					blocks: [
						{ id: "obj-l", childrenIds: ["f1"] },
						{ id: "f1", file: { targetObjectId: "ghost-file", name: "loose.png", type: "Image" } },
					],
				}),
			],
			["files/loose.png"],
		);
		expect(loose.fileLinks).toEqual([{ fromObject: "obj-l", fileObjectId: "path:files/loose.png" }]);
		expect(loose.fileBinaryByObject.get("path:files/loose.png")).toBe("files/loose.png");
		expect(loose.unresolved).toEqual([]);
	});

	it("falls back to the snippet for an unnamed object and Untitled past that", () => {
		const unnamed = parseAnytypeExport([
			snapshotFile("obj-x", "Page", { details: { snippet: "First line\nSecond" } }),
			snapshotFile("obj-y", "Page", { details: {} }),
		]);
		expect(unnamed.entities.map((e) => e.title).sort()).toEqual(["First line", "Untitled"]);
	});
});

describe("deriveTypeSchemas", () => {
	it("derives per-type PropertyDefs with inferred value types", () => {
		const schemas = deriveTypeSchemas(parseAnytypeExport(FILES, ATTACHMENTS));
		const task = schemas.find((s) => s.type === "Task");
		expect(task?.properties).toEqual([
			{ key: "done", name: "done", icon: null, valueType: ValueType.Boolean },
			// The ISO-converted date value infers as a Date property.
			{ key: "due-date", name: "Due date", icon: null, valueType: ValueType.Date },
		]);
		const page = schemas.find((s) => s.type === "Seite");
		const effort = page?.properties.find((p) => p.key === "effort");
		expect(effort?.valueType).toBe(ValueType.Number);
	});
});

describe("importAnytypeExport (vault binding)", () => {
	let workDir = "";

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "bs-anytype-"));
		USER_DATA_DIR = workDir;
		__setSqlcipherDriverForTests(null);
		__resetAtRestProbeForTests();
		await createVault({
			name: "AX",
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
		source: "anytype:v1",
		now: 1_700_000_000_000,
		importedBy: "shell:import",
	};

	const attachments = [{ path: "files/diagram.png", bytes: new Uint8Array([137, 80, 78, 71]) }];

	it("creates objects + file + links + collection, then re-imports idempotently", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");

		const first = await importAnytypeExport(session, FILES, opts, attachments);
		expect(first.created).toBe(3);
		expect(first.updated).toBe(0);
		expect(first.filesCreated).toBe(1);
		// obj-a→obj-b + obj-a→file.
		expect(first.linked).toBe(2);
		expect(first.skippedArchived).toBe(1);
		expect(first.skippedSystem).toBe(1);
		expect(first.filesMissingBinary).toBe(1);
		expect(first.unresolved).toBe(1);
		expect(first.collectionsCreated).toBe(1);
		expect(first.propertiesRegistered).toBeGreaterThan(0);

		const repo = new EntitiesRepository(await session.dataStores.open("entities"));
		const collectionId = anytypeCollectionId(opts.source, "obj-col");
		const list = repo.get(collectionId);
		expect(list?.type).toBe(LIST_ENTITY_TYPE);

		const second = await importAnytypeExport(session, FILES, opts, attachments);
		expect(second.created).toBe(0);
		expect(second.filesCreated).toBe(0);
		expect(second.updated).toBe(3);
	});

	it("aborts cleanly mid-run", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");
		const controller = new AbortController();
		controller.abort();
		const report = await importAnytypeExport(session, FILES, {
			...opts,
			signal: controller.signal,
		});
		expect(report.cancelled).toBe(true);
		expect(report.created).toBe(0);
	});
});

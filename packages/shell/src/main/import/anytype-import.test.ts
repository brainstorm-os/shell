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
import { IMPORT_EXTERNAL_ID_PROP } from "./import-types";

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
		// Known option resolves to its label; an unknown id passes through —
		// and the system dictionary lands it under the cross-app `tags` key.
		expect(a?.properties.tags).toEqual(["Urgent", "opt-ghost"]);
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

	it("maps Anytype blocks to Lexical state (not markdown), skipping chrome", () => {
		const a = plan.entities.find((e) => e.externalId === "obj-a");
		expect(a?.bodyState).not.toBeNull();
		const children = (a?.bodyState?.root as { children?: Array<Record<string, unknown>> })?.children;
		expect(Array.isArray(children)).toBe(true);
		const types = (children ?? []).map((c) => c.type);
		// Structured Lexical nodes from the fixture (paragraph, H2, checkbox
		// list, bullet list, image, bookmark, hr) — not a single markdown dump.
		expect(types).toContain("paragraph");
		expect(types).toContain("heading");
		expect(types).toContain("list");
		expect(types).toContain("image");
		expect(types).toContain("horizontalrule");
		// Snippet is plain text for search — no markdown markers.
		const snippet = String(a?.properties.body ?? "");
		expect(snippet).toContain("bold");
		expect(snippet).toContain("Milestones");
		expect(snippet).not.toContain("**bold**");
		// Title chrome is details-borne, not body content.
		expect(snippet).not.toContain("Project Phoenix");
	});

	it("maps createdDate/lastModifiedDate to createdAt/updatedAt ms", () => {
		// Fixture obj-b has dueDate as relation; dates come from details when set.
		// Synthetic: re-parse a page that carries the timestamp fields.
		const withDates = parseAnytypeExport([
			{
				path: "dated.pb.json",
				text: JSON.stringify({
					sbType: "Page",
					snapshot: {
						data: {
							details: {
								id: "obj-dated",
								name: "Dated",
								createdDate: 1_700_000_000,
								lastModifiedDate: 1_700_000_100,
							},
							blocks: [
								{ id: "obj-dated", childrenIds: ["p1"] },
								{
									id: "p1",
									text: { text: "hi", style: "Paragraph", marks: { marks: [] } },
								},
							],
						},
					},
				}),
			},
		]);
		const e = withDates.entities.find((x) => x.externalId === "obj-dated");
		expect(e?.properties.createdAt).toBe(1_700_000_000_000);
		expect(e?.properties.updatedAt).toBe(1_700_000_100_000);
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

	it("maps system relations to canonical keys ahead of display renames", () => {
		const mapped = parseAnytypeExport([
			snapshotFile("rel-tag", "STRelation", {
				details: { name: "Tag", relationKey: "tag", relationFormat: 11 },
			}),
			snapshotFile("obj-m", "Page", {
				details: { name: "Mapped", iconEmoji: "📚", tag: ["opt-x"], source: "https://x.io" },
			}),
		]);
		const m = mapped.entities[0];
		// The "Tag" display rename must NOT win over the canonical `tags` key.
		expect(m?.properties.tags).toEqual(["opt-x"]);
		expect(m?.properties.Tag).toBeUndefined();
		expect(m?.properties.icon).toBe("📚");
		expect(m?.properties.url).toBe("https://x.io");
	});

	it("mirrors user relations into a def-keyed `values` bag (F-394)", () => {
		// The shared property panel reads per-entity values from
		// `properties.values`, keyed by PropertyDef.key — the same slug
		// deriveTypeSchemas mints. Without this bag the imported tags were
		// stored top-level but the Notes panel showed "No properties yet".
		const a = plan.entities.find((e) => e.externalId === "obj-a");
		expect(a?.properties.values).toEqual({
			description: "Rebuild everything",
			tags: ["Urgent", "opt-ghost"],
			effort: 5,
			owner: "Ship importer",
		});
		const b = plan.entities.find((e) => e.externalId === "obj-b");
		expect(b?.properties.values).toEqual({
			done: true,
			"due-date": new Date(1774254674 * 1000).toISOString(),
		});
	});

	it("keeps bookkeeping + entity meta out of the values bag", () => {
		const withDates = parseAnytypeExport([
			snapshotFile("obj-meta", "Page", {
				details: {
					name: "Meta",
					iconEmoji: "📚",
					createdDate: 1_700_000_000,
					lastModifiedDate: 1_700_000_100,
				},
			}),
		]);
		const e = withDates.entities.find((x) => x.externalId === "obj-meta");
		// icon/createdAt/updatedAt are entity-level meta (panel meta rows /
		// entity chrome), never panel property rows — no values bag at all.
		expect(e?.properties.icon).toBe("📚");
		expect(e?.properties.createdAt).toBe(1_700_000_000_000);
		expect(e?.properties.values).toBeUndefined();
	});

	it("titles a name-less Note from its Title block before the snippet", () => {
		const noted = parseAnytypeExport([
			snapshotFile("obj-n", "Page", {
				details: { snippet: "First body line\nmore" },
				blocks: [
					{ id: "obj-n", childrenIds: ["header", "p1"] },
					{ id: "header", childrenIds: ["title"] },
					text("title", "Typed title", "Title"),
					text("p1", "First body line", "Paragraph"),
				],
			}),
		]);
		expect(noted.entities[0]?.title).toBe("Typed title");
	});

	it("matches binaries through the export's filename slug + truncation (F-396)", () => {
		const plan = parseAnytypeExport(
			[
				snapshotFile("f-slug", "FileObject", {
					details: { name: "Screenshot 2026-03-20 at 09.21.27", fileExt: "png" },
				}),
				snapshotFile("f-trunc", "FileObject", {
					details: {
						name: "15649 18_15 A1.2 Mo+Mi 2025-09-10 07_00 PM-[1757531820384]",
						fileExt: "pdf",
					},
				}),
				snapshotFile("obj-f", "Page", {
					details: { name: "Media page" },
					blocks: [
						{ id: "obj-f", childrenIds: ["fb1", "fb2"] },
						{ id: "fb1", file: { targetObjectId: "f-slug", type: "Image" } },
						{ id: "fb2", file: { targetObjectId: "f-trunc", type: "File" } },
					],
				}),
			],
			[
				"files/screenshot-2026-03-20-at-09-21-27.png",
				// The export truncates long stems (observed cap 46 chars).
				"files/15649-18_15-a1-2-mo-mi-2025-09-10-07_00-pm-175.pdf",
			],
		);
		expect(plan.fileBinaryByObject.get("f-slug")).toBe("files/screenshot-2026-03-20-at-09-21-27.png");
		expect(plan.fileBinaryByObject.get("f-trunc")).toBe(
			"files/15649-18_15-a1-2-mo-mi-2025-09-10-07_00-pm-175.pdf",
		);
		expect(plan.fileLinks).toHaveLength(2);
		expect(plan.filesMissingBinary).toBe(0);
	});

	it("never guesses on an ambiguous truncation prefix", () => {
		const plan = parseAnytypeExport(
			[
				snapshotFile("f-a", "FileObject", {
					details: { name: "report final version A", fileExt: "pdf" },
				}),
			],
			["files/report-f.pdf", "files/report-fi.pdf"],
		);
		expect(plan.fileBinaryByObject.has("f-a")).toBe(false);
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

	it("declares array-valued relations multi so tags render as tag lists", () => {
		const schemas = deriveTypeSchemas(parseAnytypeExport(FILES, ATTACHMENTS));
		const page = schemas.find((s) => s.type === "Seite");
		const tags = page?.properties.find((p) => p.key === "tags");
		expect(tags?.valueType).toBe(ValueType.Text);
		expect(tags?.count?.max).toBeGreaterThan(1);
	});

	it("never derives defs for the values bag or entity meta keys", () => {
		const schemas = deriveTypeSchemas(
			parseAnytypeExport([
				snapshotFile("obj-meta2", "Page", {
					objectTypes: ["ot-page"],
					details: {
						name: "Meta",
						type: "ot-page",
						iconEmoji: "📚",
						description: "keeps this one",
						createdDate: 1_700_000_000,
						lastModifiedDate: 1_700_000_100,
					},
				}),
				snapshotFile("t-page2", "STType", { details: { name: "Seite" }, key: "page" }),
			]),
		);
		const keys = schemas.flatMap((s) => s.properties.map((p) => p.key));
		expect(keys).toContain("description");
		expect(keys).not.toContain("values");
		expect(keys).not.toContain("icon");
		expect(keys).not.toContain("createdat");
		expect(keys).not.toContain("updatedat");
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
		// Collection ids must stay inside SAFE_ENTITY_ID_RE — colons / dots
		// used to make entities.create throw and collectionsCreated silently
		// counted a no-op mint.
		expect(collectionId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
		const list = repo.get(collectionId);
		expect(list?.type).toBe(LIST_ENTITY_TYPE);
		expect(list).not.toBeNull();

		const second = await importAnytypeExport(session, FILES, opts, attachments);
		expect(second.created).toBe(0);
		expect(second.filesCreated).toBe(0);
		expect(second.updated).toBe(3);
	});

	it("persists the def-keyed values bag and registers matching defs (F-394)", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");
		await importAnytypeExport(session, FILES, opts, attachments);

		const repo = new EntitiesRepository(await session.dataStores.open("entities"));
		const [aId] = repo.listIdsWithProperty(IMPORT_EXTERNAL_ID_PROP, `${opts.source}:obj-a`);
		const a = aId ? repo.get(aId) : null;
		const values = a?.properties.values as Record<string, unknown> | undefined;
		expect(values?.tags).toEqual(["Urgent", "opt-ghost"]);
		// Every values key has a registered PropertyDef, so the panel renders it.
		const store = await session.propertiesStore();
		const defs = store.snapshot().properties;
		for (const key of Object.keys(values ?? {})) {
			expect(defs[key], `def for ${key}`).toBeDefined();
		}
		expect(Object.keys(values ?? {}).length).toBeGreaterThan(0);
	});

	it("never clobbers an established catalog def with an inferred one", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");
		const store = await session.propertiesStore();
		store.setProperty({
			key: "tags",
			name: "Tags (curated)",
			icon: null,
			valueType: ValueType.Text,
			count: { min: 0, max: 25 },
		});

		const report = await importAnytypeExport(session, FILES, opts, attachments);
		const after = store.snapshot().properties.tags;
		expect(after?.name).toBe("Tags (curated)");
		expect(after?.count).toEqual({ min: 0, max: 25 });
		// The pre-seeded key is skipped; the rest still registered.
		expect(report.propertiesRegistered).toBeGreaterThan(0);
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

	it("plants markdown bodies into the Y.Doc when applyDocUpdate is provided", async () => {
		const session = getActiveVaultSession();
		if (!session) throw new Error("no session");
		const planted = new Map<string, string>();
		const report = await importAnytypeExport(
			session,
			FILES,
			{
				...opts,
				applyDocUpdate: async (entityId, updateB64) => {
					planted.set(entityId, updateB64);
				},
			},
			[{ path: "files/diagram.png", bytes: new Uint8Array([1, 2, 3, 4]) }],
		);
		expect(report.created).toBeGreaterThan(0);
		// Every entity with a body should have received a plant.
		expect(planted.size).toBeGreaterThan(0);
		for (const b64 of planted.values()) {
			expect(b64.length).toBeGreaterThan(8);
		}
	});
});

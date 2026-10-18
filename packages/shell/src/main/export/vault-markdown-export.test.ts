import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BASELINE_NODES,
	SEED_STANDIN_NODES,
	plantSerializedStateIntoDoc,
} from "@brainstorm-os/editor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository } from "../storage/entities-repo";
import { YDocStore } from "../storage/ydoc-store";
import {
	type ReferenceResolver,
	exportVaultMarkdown,
	fileSafeName,
	frontMatter,
	planEntityPaths,
	relativeLink,
	rewritePropertyValue,
} from "./vault-markdown-export";

const NOTE = "io.brainstorm.notes/Note/v1";
const TASK = "brainstorm/Task/v1";

const text = (t: string) => ({
	type: "text",
	version: 1,
	detail: 0,
	format: 0,
	mode: "normal",
	style: "",
	text: t,
});
const el = (type: string, children: unknown[], extra: Record<string, unknown> = {}) => ({
	type,
	version: 1,
	direction: "ltr",
	format: "",
	indent: 0,
	children,
	...extra,
});

function bodyUpdate(children: unknown[]): Uint8Array {
	const doc = new Y.Doc();
	plantSerializedStateIntoDoc(doc, { root: el("root", children) } as never, {
		nodes: [...BASELINE_NODES, ...SEED_STANDIN_NODES],
	});
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return update;
}

describe("path planning", () => {
	it("makes names safe on every OS", () => {
		expect(fileSafeName('a/b:c*?"<>|d')).toBe("a b c d");
		expect(fileSafeName("  ...  ")).toBe("Untitled");
		expect(fileSafeName("CON")).toBe("CON_");
		expect(fileSafeName("a\u0000b\nc")).toBe("a b c");
		expect(fileSafeName("x".repeat(300))).toHaveLength(80);
	});

	it("groups by type and dedupes names case-insensitively", () => {
		const paths = planEntityPaths([
			{ id: "a", type: NOTE, title: "Plan" },
			{ id: "b", type: NOTE, title: "plan" },
			{ id: "c", type: TASK, title: "Plan" },
			{ id: "d", type: NOTE, title: "" },
		]);
		expect([...paths.values()]).toEqual([
			"Notes/Plan.md",
			"Notes/plan (2).md",
			"Tasks/Plan.md",
			"Notes/Untitled.md",
		]);
	});

	it("links relatively with encoded segments", () => {
		expect(relativeLink("Notes/A.md", "Tasks/Ship it (2).md")).toBe("../Tasks/Ship%20it%20(2).md");
		expect(relativeLink("Notes/A.md", "Notes/B.md")).toBe("B.md");
	});
});

describe("reference rewriting", () => {
	const resolve: ReferenceResolver = {
		entityLink: (id) => (id === "exported" ? "../Notes/Exported.md" : null),
		isKnownEntity: (id) => id === "exported" || id === "hidden",
		entityLabel: (id) => (id === "hidden" ? "Hidden thing" : "Exported"),
		assetLink: (id) => (id === "asset1" ? "../assets/asset1.png" : null),
	};

	it("turns ids into links or labels and never leaks an unexported id", () => {
		expect(rewritePropertyValue("exported", resolve)).toBe("../Notes/Exported.md");
		expect(rewritePropertyValue(["hidden", "plain"], resolve)).toEqual(["Hidden thing", "plain"]);
		expect(rewritePropertyValue("brainstorm://entity/hidden", resolve)).toBe("Hidden thing");
		expect(rewritePropertyValue({ cover: "asset1" }, resolve)).toEqual({
			cover: "../assets/asset1.png",
		});
		expect(rewritePropertyValue("see brainstorm://asset/gone", resolve)).toBe("see ");
		expect(JSON.stringify(rewritePropertyValue({ hidden: 1, x: "hidden" }, resolve))).not.toContain(
			"hidden",
		);
	});

	it("writes front matter as JSON-quoted YAML", () => {
		expect(
			frontMatter([
				["title", 'a: "b"'],
				["weird key", 1],
				["skip", undefined],
			]),
		).toBe('---\ntitle: "a: \\"b\\""\n"weird key": 1\n---\n');
	});
});

describe("exportVaultMarkdown", () => {
	let vaultDir: string;
	let destDir: string;
	let stores: DataStores;
	let repo: EntitiesRepository;
	let ydocStore: YDocStore;

	const assetBytes = new Uint8Array([137, 80, 78, 71]);
	const assetStore = {
		listBound: () => [{ assetId: "img1", mime: "image/png" }],
		readAsset: async (id: string) =>
			id === "img1" ? { bytes: assetBytes, mime: "image/png" } : null,
	};

	const session = () =>
		({
			dataStores: stores,
			assetStore: async () => assetStore,
			ydocStore,
		}) as unknown as Parameters<typeof exportVaultMarkdown>[0];

	const create = (id: string, type: string, properties: Record<string, unknown>) =>
		repo.create({ id, type, properties, createdBy: "io.test", now: 1_700_000_000_000, dekId: null });

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-md-export-vault-"));
		destDir = await mkdtemp(join(tmpdir(), "bs-md-export-dest-"));
		stores = new DataStores(vaultDir);
		repo = new EntitiesRepository(await stores.open("entities"));
		ydocStore = new YDocStore(vaultDir);
	});
	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
		await rm(destDir, { recursive: true, force: true });
	});

	it("writes a type-grouped tree with front matter, relative links and copied assets", async () => {
		create("note_a", NOTE, { title: "Roadmap", status: "draft", relatedTo: "task_b" });
		create("task_b", TASK, { title: "Ship it", parent: "deleted_c" });
		create("deleted_c", NOTE, { title: "Old idea" });
		repo.softDelete("deleted_c", 1_700_000_000_001);
		create("view_1", "brainstorm/ListView/v1", { title: "A view" });
		await ydocStore.writeSnapshot(
			"note_a",
			bodyUpdate([
				el("title", [text("Roadmap")]),
				el("paragraph", [
					text("Next: "),
					{ type: "mention", version: 1, entityId: "task_b", entityType: TASK, label: "Ship it" },
					text(" then "),
					{ type: "mention", version: 1, entityId: "deleted_c", entityType: NOTE, label: "Old idea" },
					text(" and "),
					el("link", [text("the view")], { url: "brainstorm://entity/view_1", rel: null, target: null }),
				]),
				{
					type: "image",
					version: 1,
					src: "brainstorm://asset/img1",
					altText: "chart",
					width: "inherit",
					caption: "",
				},
			]),
		);

		const progress: number[] = [];
		const result = await exportVaultMarkdown(session(), {
			destDir,
			now: Date.UTC(2026, 9, 18),
			onProgress: (done) => progress.push(done),
		});
		expect(result).toMatchObject({ entities: 2, assets: 1 });
		expect(result?.path).toBe(join(destDir, "Brainstorm export 2026-10-18"));
		expect(progress).toEqual([1, 2]);

		const root = result?.path ?? "";
		expect((await readdir(root)).sort()).toEqual(["Notes", "Tasks", "assets"]);
		const note = await readFile(join(root, "Notes", "Roadmap.md"), "utf8");
		expect(note).toContain('type: "Notes"');
		expect(note).toContain('relatedTo: "../Tasks/Ship%20it.md"');
		expect(note).toContain("# Roadmap");
		expect(note).toContain("Next: [Ship it](../Tasks/Ship%20it.md) then Old idea and the view");
		expect(note).toContain("![chart](../assets/img1.png)");
		const task = await readFile(join(root, "Tasks", "Ship it.md"), "utf8");
		expect(task).toContain('parent: "Old idea"');
		expect(task).toContain("# Ship it");
		for (const file of [note, task]) {
			for (const id of ["note_a", "task_b", "deleted_c", "view_1", "brainstorm://"]) {
				expect(file).not.toContain(id);
			}
		}
		expect(await readFile(join(root, "assets", "img1.png"))).toEqual(Buffer.from(assetBytes));
	});

	it("never overwrites an earlier export of the same day", async () => {
		create("n", NOTE, { title: "One" });
		const first = await exportVaultMarkdown(session(), { destDir, now: 0 });
		const second = await exportVaultMarkdown(session(), { destDir, now: 0 });
		expect(second?.path).toBe(`${first?.path} (2)`);
	});

	it("removes the partial folder when aborted mid-run", async () => {
		for (let i = 0; i < 3; i += 1) create(`n${i}`, NOTE, { title: `N${i}` });
		const controller = new AbortController();
		const result = await exportVaultMarkdown(session(), {
			destDir,
			now: 0,
			signal: controller.signal,
			onProgress: (done) => {
				if (done === 1) controller.abort();
			},
		});
		expect(result).toBeNull();
		expect(await readdir(destDir)).toEqual([]);
	});
});

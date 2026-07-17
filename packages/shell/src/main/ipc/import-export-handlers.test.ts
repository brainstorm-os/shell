/**
 * IE-3 Backup & Migration handler tests. Electron is mocked (no Electron in
 * Vitest); the handlers run against a REAL vault session so the import dry-run
 * / run and the `.bsbundle` export are proven end-to-end through the IE-1 /
 * IE-2 engines, not just shape-validated.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();

let USER_DATA_DIR = "";
const showOpenDialog = vi.fn();
const showSaveDialog = vi.fn();

vi.mock("electron", () => ({
	app: { getPath: () => USER_DATA_DIR },
	ipcMain: {
		handle: (channel: string, fn: IpcHandler) => {
			handlers.set(channel, fn);
		},
	},
	dialog: {
		showOpenDialog: (...args: unknown[]) => showOpenDialog(...args),
		showSaveDialog: (...args: unknown[]) => showSaveDialog(...args),
	},
}));

import { unpackBundle } from "../bundle/bundle-archive";
import { __resetAtRestProbeForTests } from "../storage/at-rest-mode";
import { EntitiesRepository } from "../storage/entities-repo";
import { __setSqlcipherDriverForTests } from "../storage/sqlite";
import { closeActiveVaultSession, getActiveVaultSession } from "../vault/session";
import { createVault } from "../vault/vault";
import {
	__resetPendingImportForTests,
	registerImportExportHandlers,
} from "./import-export-handlers";

const TYPE = "test/Note/v1";

/** Build a minimal stored (uncompressed) PKZIP archive for the Notion test. */
function makeStoredZip(members: { name: string; data: Buffer }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const m of members) {
		const name = Buffer.from(m.name, "utf8");
		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt32LE(m.data.length, 18);
		local.writeUInt32LE(m.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);
		const localRecord = Buffer.concat([local, m.data]);
		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt32LE(m.data.length, 20);
		central.writeUInt32LE(m.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);
		locals.push(localRecord);
		centrals.push(central);
		offset += localRecord.length;
	}
	const localBlock = Buffer.concat(locals);
	const centralBlock = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(members.length, 8);
	eocd.writeUInt16LE(members.length, 10);
	eocd.writeUInt32LE(centralBlock.length, 12);
	eocd.writeUInt32LE(localBlock.length, 16);
	return Buffer.concat([localBlock, centralBlock, eocd]);
}

let workDir = "";

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
	const fn = handlers.get(channel);
	if (!fn) throw new Error(`no handler for ${channel}`);
	return fn({}, ...args);
}

async function entitiesRepo(): Promise<EntitiesRepository> {
	const session = getActiveVaultSession();
	if (!session) throw new Error("no session");
	return new EntitiesRepository(await session.dataStores.open("entities"));
}

beforeEach(async () => {
	handlers.clear();
	showOpenDialog.mockReset();
	showSaveDialog.mockReset();
	__resetPendingImportForTests();
	workDir = await mkdtemp(join(tmpdir(), "bs-ie3-"));
	USER_DATA_DIR = workDir;
	__setSqlcipherDriverForTests(null);
	__resetAtRestProbeForTests();
	await createVault({
		name: "IE3",
		path: join(workDir, "vault"),
		keystore: { forceInsecure: true },
		seedStarterContent: false,
	});
	registerImportExportHandlers({ getDashboard: () => null });
});

afterEach(async () => {
	closeActiveVaultSession();
	await rm(workDir, { recursive: true, force: true });
});

describe("IE-3 import handlers", () => {
	it("picks a JSONL source, dry-runs a plan, and commits the run", async () => {
		const src = join(workDir, "notes.jsonl");
		await writeFile(
			src,
			[
				JSON.stringify({ id: "n1", title: "First", body: "a" }),
				JSON.stringify({ id: "n2", title: "Second", body: "b" }),
			].join("\n"),
		);
		showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [src] });

		const preview = (await invoke("import-export:pick-source")) as {
			recordCount: number;
			columns: string[];
		};
		expect(preview.recordCount).toBe(2);
		expect(preview.columns).toContain("title");

		const plan = (await invoke("import-export:plan", TYPE)) as {
			willCreate: number;
			willUpdate: number;
			total: number;
		};
		expect(plan).toMatchObject({ willCreate: 2, willUpdate: 0, total: 2 });

		const report = (await invoke("import-export:run", TYPE)) as {
			created: number;
			updated: number;
		};
		expect(report).toMatchObject({ created: 2, updated: 0 });
	});

	it("streams progress events to the dashboard during a run", async () => {
		const sent: Array<{ channel: string; payload: unknown }> = [];
		// Re-register the handlers with a dashboard window that captures sends.
		registerImportExportHandlers({
			getDashboard: () =>
				({
					webContents: {
						send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
					},
				}) as never,
		});

		const src = join(workDir, "many.jsonl");
		await writeFile(
			src,
			Array.from({ length: 3 }, (_, n) => JSON.stringify({ id: `r${n}`, title: `T${n}` })).join("\n"),
		);
		showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [src] });
		await invoke("import-export:pick-source");
		await invoke("import-export:run", TYPE);

		const progress = sent.filter((s) => s.channel === "import-export:progress");
		expect(progress.length).toBeGreaterThan(0);
		expect(progress.at(-1)?.payload).toEqual({ done: 3, total: 3 });
	});

	it("registers a cancel channel that is a no-op when idle", async () => {
		await expect(invoke("import-export:cancel")).resolves.toBeUndefined();
	});

	it("rejects a plan with no target type and a run before a pick", async () => {
		await expect(invoke("import-export:plan", "")).rejects.toThrow(/target entity type/);
		await expect(invoke("import-export:run", TYPE)).rejects.toThrow(/no source picked/);
	});

	it("returns null when the open dialog is canceled", async () => {
		showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
		expect(await invoke("import-export:pick-source")).toBeNull();
	});

	it("picks a CSV source and applies an interactive mapping override on run", async () => {
		const src = join(workDir, "people.csv");
		await writeFile(src, "id,full_name,scratch\n1,Ada,drop-me\n2,Linus,drop-me\n");
		showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [src] });

		const preview = (await invoke("import-export:pick-source")) as { columns: string[] };
		expect(preview.columns).toEqual(["id", "full_name", "scratch"]);

		// Rename full_name → name, exclude the scratch column.
		const edits = [
			{ column: "id", property: "id", include: true },
			{ column: "full_name", property: "name", include: true },
			{ column: "scratch", property: "scratch", include: false },
		];
		const report = (await invoke("import-export:run", TYPE, edits)) as { created: number };
		expect(report.created).toBe(2);

		const repo = await entitiesRepo();
		const ada = repo.query({ type: [TYPE] }).find((e) => e.properties.name === "Ada");
		expect(ada).toBeDefined();
		expect(ada?.properties.name).toBe("Ada");
		expect("full_name" in (ada?.properties ?? {})).toBe(false);
		expect("scratch" in (ada?.properties ?? {})).toBe(false);
	});

	it("imports an Obsidian folder (recursive .md walk → notes + links + referenced attachment)", async () => {
		const vaultDir = join(workDir, "obsidian-vault");
		await mkdir(join(vaultDir, "sub"), { recursive: true });
		await mkdir(join(vaultDir, "assets"), { recursive: true });
		await writeFile(
			join(vaultDir, "Alpha.md"),
			"---\ntitle: Alpha\n---\nSee [[Beta]] and ![[wire.png]].\n",
		);
		await writeFile(join(vaultDir, "sub", "Beta.md"), "Back to [[Alpha]].\n");
		await writeFile(join(vaultDir, "assets", "wire.png"), Buffer.from([1, 2, 3, 4]));
		await writeFile(join(vaultDir, "assets", "unused.png"), Buffer.from([9, 9])); // not referenced
		// A .canvas alongside the notes → a Whiteboard + edge (IE-5 tail).
		await writeFile(
			join(vaultDir, "Board.canvas"),
			JSON.stringify({
				nodes: [
					{ id: "n1", type: "text", text: "One", x: 0, y: 0 },
					{ id: "n2", type: "text", text: "Two", x: 200, y: 0 },
				],
				edges: [{ id: "c1", fromNode: "n1", toNode: "n2" }],
			}),
		);
		showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [vaultDir] });

		const preview = (await invoke("import-export:pick-obsidian")) as { noteCount: number };
		expect(preview.noteCount).toBe(2);

		const report = (await invoke("import-export:run-obsidian", "test/Note/v1")) as {
			created: number;
		};
		// 2 notes + 1 referenced File/v1 + 1 Whiteboard + 1 edge (unused.png NOT imported).
		expect(report.created).toBe(5);

		const repo = await entitiesRepo();
		expect(repo.query({ type: ["test/Note/v1"] })).toHaveLength(2);
		const files = repo.query({ type: ["brainstorm/File/v1"] });
		expect(files).toHaveLength(1);
		expect(files[0]?.properties.name).toBe("wire.png");
		const boards = repo.query({ type: ["brainstorm/Whiteboard/v1"] });
		expect(boards).toHaveLength(1);
		expect(boards[0]?.properties.name).toBe("Board");
		expect(repo.query({ type: ["brainstorm/WhiteboardEdge/v1"] })).toHaveLength(1);
	});

	it("imports a Notion export zip (pages + database rows, idempotent)", async () => {
		const PID = "0123456789abcdef0123456789abcdef";
		const zip = makeStoredZip([
			{ name: `Projects ${PID}.md`, data: Buffer.from("# Projects\n\nOur work.\n") },
			{
				name: `Tasks ${"2".repeat(32)}.csv`,
				data: Buffer.from("Name,Status\nShip it,Done\nTest it,Open\n"),
			},
		]);
		const archive = join(workDir, "notion-export.zip");
		await writeFile(archive, zip);
		showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [archive] });

		const preview = (await invoke("import-export:pick-notion")) as { pageCount: number };
		expect(preview.pageCount).toBe(3); // 1 page + 2 database rows

		const report = (await invoke("import-export:run-notion", TYPE)) as { created: number };
		expect(report.created).toBe(3);

		const repo = await entitiesRepo();
		expect(repo.query({ type: [TYPE] })).toHaveLength(3);

		// Re-import the same export: no duplicates.
		await writeFile(archive, zip);
		showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [archive] });
		await invoke("import-export:pick-notion");
		const second = (await invoke("import-export:run-notion", TYPE)) as { created: number };
		expect(second.created).toBe(0);
		expect(repo.query({ type: [TYPE] })).toHaveLength(3);
	});

	it("imports a Notion export folder (unzipped Markdown & CSV)", async () => {
		const PID = "abcdef0123456789abcdef0123456789";
		const folder = join(workDir, "notion-folder-export");
		await mkdir(folder, { recursive: true });
		await writeFile(join(folder, `Projects ${PID}.md`), "# Projects\n\nOur work.\n");
		await writeFile(
			join(folder, `Tasks ${"3".repeat(32)}.csv`),
			"Name,Status\nShip it,Done\nTest it,Open\n",
		);
		showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [folder] });

		const preview = (await invoke("import-export:pick-notion")) as {
			pageCount: number;
			archiveName: string;
		};
		expect(preview.archiveName).toBe("notion-folder-export");
		expect(preview.pageCount).toBe(3);

		const report = (await invoke("import-export:run-notion", TYPE)) as { created: number };
		expect(report.created).toBe(3);
		const repo = await entitiesRepo();
		expect(repo.query({ type: [TYPE] })).toHaveLength(3);
	});

	it("exports the vault to a .bsbundle the codec can unpack", async () => {
		const out = join(workDir, "vault.bsbundle");
		showSaveDialog.mockResolvedValue({ canceled: false, filePath: out });
		const result = (await invoke("import-export:export-vault")) as { path: string } | null;
		expect(result?.path).toBe(out);
		const bytes = await readFile(out);
		const files = unpackBundle(new Uint8Array(bytes));
		expect(files.has("manifest.json")).toBe(true);
	});
});

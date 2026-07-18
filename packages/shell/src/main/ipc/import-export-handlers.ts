/**
 * Backup & Migration IPC (IE-3) — the dashboard-trusted surface over the
 * IE-1 bundle codec (`bundle/vault-export.ts`) + the IE-2 import engine
 * (`import/vault-import-engine.ts`).
 *
 * Privileged, NOT a broker service: these handlers run on `ipcMain.handle`
 * and are wired only into the dashboard preload (`window.brainstorm.importExport`),
 * exactly like `covers-handlers` / `icons-handlers`. Sandboxed apps reach the
 * import engine through its own capability-gated broker service (IE-2 tail),
 * never this surface — vault-wide export/import is an owner action.
 *
 * The picked source file's text is held in a module-level pending slot rather
 * than shuttled to the renderer and back: the renderer picks → previews →
 * dry-runs → commits against the same in-memory payload. The slot is replaced
 * on each pick and cleared after a committed run.
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { ValueType } from "@brainstorm/sdk-types";
import { type BrowserWindow, dialog, ipcMain } from "electron";
import { BundleExportScopeKind } from "../bundle/bundle-format";
import { exportVaultBundle } from "../bundle/vault-export";
import {
	type AnytypeAttachment,
	type AnytypeFile,
	type AnytypeImportPlan,
	anytypeImportSource,
	importAnytypeExport,
	parseAnytypeExport,
} from "../import/anytype-import";
import { inferMapping } from "../import/import-map";
import { parseTable } from "../import/import-parse";
import {
	ImportFormat,
	type ImportPlan,
	type ImportRunReport,
	type MappingPlan,
} from "../import/import-types";
import {
	type NotionAttachment,
	type NotionFile,
	importNotionExport,
	parseNotionExport,
} from "../import/notion-import";
import { type CanvasFile, importObsidianCanvas } from "../import/obsidian-canvas";
import {
	type ObsidianAttachment,
	type ObsidianFile,
	importObsidianVault,
	parseObsidianVault,
} from "../import/obsidian-import";
import { importRecordsIntoVault, planRecordsImport } from "../import/vault-import-engine";
import { type ZipReadLimits, readZip, zipEntryText } from "../import/zip-read";
import type { VaultSession } from "../vault/session";
import { getActiveVaultSession } from "../vault/session";

/** Bounds on an Obsidian-folder walk — a hostile / huge folder must not exhaust
 *  memory by reading every file in. Generous for any real personal vault. */
const MAX_OBSIDIAN_FILES = 50_000;
const MAX_OBSIDIAN_TOTAL_BYTES = 512 * 1024 * 1024;

/** Provenance recorded as `createdBy` on imported entities — the import is an
 *  owner action through the dashboard, not attributable to any sandboxed app. */
const IMPORT_AUTHOR = "shell:import";

/** The in-flight run's abort controller, so `import-export:cancel` can stop it
 *  (doc 45 §Streaming). One run at a time (the wizard is modal). */
let activeRun: AbortController | null = null;

type PendingImport = {
	readonly text: string;
	readonly format: ImportFormat;
	readonly fileName: string;
	/** Vault the source was picked against — a lock/switch between pick and run
	 *  must not write one vault's file into another. */
	readonly vaultId: string;
};

let pendingImport: PendingImport | null = null;

/** A picked Obsidian vault folder, read into memory + bound to its vault. The
 *  markdown is held as text; attachment bytes are read lazily at run time (only
 *  the ones a note references) from `root`. */
type PendingObsidian = {
	readonly folderName: string;
	readonly root: string;
	readonly files: readonly ObsidianFile[];
	readonly attachmentPaths: readonly string[];
	readonly vaultId: string;
};
let pendingObsidian: PendingObsidian | null = null;

/** Preview after an Obsidian folder pick. */
export type ObsidianSourcePreview = {
	readonly folderName: string;
	readonly noteCount: number;
};

/** A picked Notion export (`.zip` or unzipped folder), loaded into memory +
 *  bound to its vault. */
type PendingNotion = {
	readonly archiveName: string;
	readonly files: readonly NotionFile[];
	readonly attachments: readonly NotionAttachment[];
	readonly vaultId: string;
};
let pendingNotion: PendingNotion | null = null;

/** Limits on a Notion export extraction (zip-slip + zip-bomb defence; same
 *  bounds apply to a folder walk of an unzipped export). */
const NOTION_ZIP_LIMITS: ZipReadLimits = {
	maxEntries: 100_000,
	maxEntryBytes: 256 * 1024 * 1024,
	maxTotalBytes: MAX_OBSIDIAN_TOTAL_BYTES,
};
const NOTION_TEXT_EXT = /\.(md|markdown|csv|html|htm)$/i;

/** Preview after a Notion export pick. */
export type NotionSourcePreview = {
	readonly archiveName: string;
	readonly pageCount: number;
};

/** A picked Anytype export (`.zip` or folder), bound to its vault. The
 *  snapshot JSONs are held as text and parsed ONCE at pick time (`plan` is
 *  reused by the run). Binary handling differs by source: a zip is already
 *  fully in memory, so only the plan-referenced attachments are kept
 *  (`attachments`); a folder pick records paths only (`root` +
 *  `referencedPaths`) and the bytes are read lazily at run time — mirroring
 *  the Obsidian `walkVault` pattern. */
type PendingAnytype = {
	readonly archiveName: string;
	readonly files: readonly AnytypeFile[];
	readonly plan: AnytypeImportPlan;
	/** Zip pick: plan-referenced attachment bytes, already in memory. */
	readonly attachments: readonly AnytypeAttachment[] | null;
	/** Folder pick: root to read `referencedPaths` from at run time. */
	readonly root: string | null;
	readonly referencedPaths: readonly string[];
	readonly vaultId: string;
};
let pendingAnytype: PendingAnytype | null = null;

/** Limits on an Anytype export extraction (zip-slip + zip-bomb defence; same
 *  bounds apply to a folder walk of an unzipped export). */
const ANYTYPE_ZIP_LIMITS: ZipReadLimits = {
	maxEntries: 100_000,
	maxEntryBytes: 256 * 1024 * 1024,
	maxTotalBytes: MAX_OBSIDIAN_TOTAL_BYTES,
};
const ANYTYPE_JSON_EXT = /\.(pb\.json|json)$/i;

/** Preview after an Anytype export pick. */
export type AnytypeSourcePreview = {
	readonly archiveName: string;
	readonly objectCount: number;
};

/** One file from an export folder walk — path is vault-relative with `/`
 *  separators (matches zip entry paths). */
type WalkedExportEntry = {
	readonly path: string;
	readonly bytes: Uint8Array;
};

/** Recursively read every regular file under `root`, applying the same
 *  entry/total byte ceilings the zip reader enforces. Symlinks are skipped
 *  (`isFile()` is false for them), so the walk can't escape the chosen folder. */
async function walkExportFolder(root: string, limits: ZipReadLimits): Promise<WalkedExportEntry[]> {
	const dirents = await readdir(root, { recursive: true, withFileTypes: true });
	const out: WalkedExportEntry[] = [];
	let totalBytes = 0;
	let entries = 0;
	for (const dirent of dirents) {
		if (!dirent.isFile()) continue;
		const parent = (dirent as unknown as { parentPath?: string; path?: string }).parentPath ?? root;
		const absolute = join(parent, dirent.name);
		const path = relative(root, absolute).split(sep).join("/");
		if (++entries > limits.maxEntries) {
			throw new Error("import-export: export has too many files");
		}
		const bytes = new Uint8Array(await readFile(absolute));
		totalBytes += bytes.length;
		if (bytes.length > limits.maxEntryBytes || totalBytes > limits.maxTotalBytes) {
			throw new Error("import-export: export is too large");
		}
		out.push({ path, bytes });
	}
	return out;
}

/** Recursively scan an unzipped Anytype export: read every snapshot JSON's
 *  text into memory (same entry/total ceilings the zip reader enforces) and
 *  collect the export-relative paths of every other file WITHOUT reading its
 *  bytes — only the binaries the parsed plan references are read later, at
 *  run time (mirrors the Obsidian `walkVault` pattern). Symlinks are skipped
 *  (`isFile()` is false for them), so the walk can't escape the folder. */
async function walkAnytypeExportFolder(
	root: string,
): Promise<{ files: AnytypeFile[]; attachmentPaths: string[] }> {
	const dirents = await readdir(root, { recursive: true, withFileTypes: true });
	const files: AnytypeFile[] = [];
	const attachmentPaths: string[] = [];
	let totalBytes = 0;
	let entries = 0;
	for (const dirent of dirents) {
		if (!dirent.isFile()) continue;
		const parent = (dirent as unknown as { parentPath?: string; path?: string }).parentPath ?? root;
		const absolute = join(parent, dirent.name);
		const path = relative(root, absolute).split(sep).join("/");
		if (++entries > ANYTYPE_ZIP_LIMITS.maxEntries) {
			throw new Error("import-export: export has too many files");
		}
		if (!ANYTYPE_JSON_EXT.test(path)) {
			attachmentPaths.push(path);
			continue;
		}
		const text = await readFile(absolute, "utf8");
		const bytes = Buffer.byteLength(text, "utf8");
		totalBytes += bytes;
		if (bytes > ANYTYPE_ZIP_LIMITS.maxEntryBytes || totalBytes > ANYTYPE_ZIP_LIMITS.maxTotalBytes) {
			throw new Error("import-export: export is too large");
		}
		files.push({ path, text });
	}
	return { files, attachmentPaths };
}

/** The export-relative binary paths the plan actually consumes at run time —
 *  a `fileLinks` edge resolved through `fileBinaryByObject`. Everything else
 *  in the export is never read (folder pick) or not carried past the pick
 *  (zip pick). */
function anytypeReferencedBinaryPaths(plan: AnytypeImportPlan): Set<string> {
	const referenced = new Set<string>();
	for (const link of plan.fileLinks) {
		const path = plan.fileBinaryByObject.get(link.fileObjectId);
		if (path) referenced.add(path);
	}
	return referenced;
}

function requirePendingAnytypeFor(vaultId: string): PendingAnytype {
	if (!pendingAnytype) throw new Error("import-export: no Anytype export picked");
	if (pendingAnytype.vaultId !== vaultId) {
		pendingAnytype = null;
		throw new Error("import-export: the active vault changed — pick the export again");
	}
	return pendingAnytype;
}

function requirePendingNotionFor(vaultId: string): PendingNotion {
	if (!pendingNotion) throw new Error("import-export: no Notion export picked");
	if (pendingNotion.vaultId !== vaultId) {
		pendingNotion = null;
		throw new Error("import-export: the active vault changed — pick the export again");
	}
	return pendingNotion;
}

/** Resolve the pending source, asserting it belongs to the active vault. */
function requirePendingFor(vaultId: string): PendingImport {
	if (!pendingImport) throw new Error("import-export: no source picked");
	if (pendingImport.vaultId !== vaultId) {
		pendingImport = null;
		throw new Error("import-export: the active vault changed — pick the source again");
	}
	return pendingImport;
}

function requirePendingObsidianFor(vaultId: string): PendingObsidian {
	if (!pendingObsidian) throw new Error("import-export: no Obsidian folder picked");
	if (pendingObsidian.vaultId !== vaultId) {
		pendingObsidian = null;
		throw new Error("import-export: the active vault changed — pick the folder again");
	}
	return pendingObsidian;
}

/** Recursively scan an Obsidian vault folder: read every `.md` file's text into
 *  memory (bounded by count + total bytes) and collect the vault-relative paths
 *  of every other file (attachment candidates) WITHOUT reading their bytes —
 *  only the bytes a note references are read later, at run time. Symlinks are
 *  skipped (`isFile()` is false for them), so the walk can't read outside the
 *  chosen folder. */
async function walkVault(
	root: string,
): Promise<{ files: ObsidianFile[]; attachmentPaths: string[] }> {
	const dirents = await readdir(root, { recursive: true, withFileTypes: true });
	const files: ObsidianFile[] = [];
	const attachmentPaths: string[] = [];
	let totalBytes = 0;
	for (const dirent of dirents) {
		if (!dirent.isFile()) continue;
		const parent = (dirent as unknown as { parentPath?: string; path?: string }).parentPath ?? root;
		const rel = relative(root, join(parent, dirent.name));
		if (!/\.md$/i.test(dirent.name)) {
			if (attachmentPaths.length < MAX_OBSIDIAN_FILES) attachmentPaths.push(rel);
			continue;
		}
		if (files.length >= MAX_OBSIDIAN_FILES) {
			throw new Error(`import-export: folder exceeds ${MAX_OBSIDIAN_FILES} markdown files`);
		}
		const text = await readFile(join(parent, dirent.name), "utf8");
		totalBytes += Buffer.byteLength(text, "utf8");
		if (totalBytes > MAX_OBSIDIAN_TOTAL_BYTES) {
			throw new Error("import-export: Obsidian folder is too large to read in");
		}
		files.push({ path: rel, text });
	}
	return { files, attachmentPaths };
}

/** Read the bytes of the attachment files a note references, bounded by total
 *  size. Each path is resolved under `root` and re-checked to stay inside it
 *  (defence against a stray `..` in the relative paths). */
async function readReferencedAttachments(
	root: string,
	paths: readonly string[],
): Promise<ObsidianAttachment[]> {
	const out: ObsidianAttachment[] = [];
	let totalBytes = 0;
	const rootResolved = resolve(root);
	for (const rel of paths) {
		const abs = resolve(root, rel);
		if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) continue;
		const bytes = new Uint8Array(await readFile(abs));
		totalBytes += bytes.length;
		if (totalBytes > MAX_OBSIDIAN_TOTAL_BYTES) {
			throw new Error("import-export: referenced attachments exceed the import size limit");
		}
		out.push({ path: rel, bytes });
	}
	return out;
}

/** Preview returned to the wizard after a file pick: enough to choose a target
 *  type + show the inferred column→property bindings, without the full text. */
export type ImportSourcePreview = {
	readonly fileName: string;
	readonly format: ImportFormat;
	readonly columns: readonly string[];
	readonly recordCount: number;
};

/** A projection of one column's mapping for the wizard. The wizard edits
 *  `property` + `include` and sends the set back as the run override; the
 *  inferred `valueType` + dedupe column are kept main-side (the user picks
 *  *where* a column lands, not how its values are typed — that stays the
 *  engine's conservative inference). */
export type ImportMappingPreview = {
	readonly column: string;
	readonly property: string;
	readonly valueType: string;
	readonly include: boolean;
};

/** A user edit to the inferred mapping: per column, the target property +
 *  whether to import it. */
export type ImportMappingEdit = {
	readonly column: string;
	readonly property: string;
	readonly include: boolean;
};

export type ImportExportHandlersOptions = {
	getDashboard: () => BrowserWindow | null;
	/** Plant imported markdown into each entity's universal-body Y.Doc.
	 *  Mirrors the Welcome-2 template channel — without this, Notes opens
	 *  blank because editors bind to the Y.Doc, not `properties.body`. */
	makeApplyDocUpdate?: (vaultPath: string) => (entityId: string, updateB64: string) => Promise<void>;
	/** Read an entity's CURRENT body-doc snapshot (base64 full-state, ydoc
	 *  worker `snapshot`). Importers use it to REPLACE an existing body on
	 *  re-import instead of appending a duplicate copy (F-398). */
	makeLoadDocSnapshot?: (vaultPath: string) => (entityId: string) => Promise<string | null>;
};

function formatFromExt(path: string): ImportFormat | null {
	const ext = extname(path).toLowerCase();
	if (ext === ".json") return ImportFormat.Json;
	if (ext === ".jsonl" || ext === ".ndjson") return ImportFormat.Jsonl;
	if (ext === ".csv") return ImportFormat.Csv;
	if (ext === ".md" || ext === ".markdown") return ImportFormat.Markdown;
	if (ext === ".html" || ext === ".htm") return ImportFormat.Html;
	return null;
}

/** The target type's existing PropertyDefs as key → ValueType, so inference can
 *  land columns in the shape the type already declares (IE-2 map-onto-type). */
async function knownPropsFor(session: VaultSession): Promise<ReadonlyMap<string, ValueType>> {
	const store = await session.propertiesStore();
	const map = new Map<string, ValueType>();
	for (const [key, def] of Object.entries(store.snapshot().properties)) {
		map.set(key, def.valueType);
	}
	return map;
}

/** Build the mapping for a plan/run: the engine's inferred base, with any
 *  user edits (target property + include) overlaid by column name. The
 *  inferred `valueType` + `dedupeColumn` are preserved. */
function resolveMapping(
	pending: PendingImport,
	targetType: string,
	edits: readonly ImportMappingEdit[] | null,
	knownProps: ReadonlyMap<string, ValueType>,
): MappingPlan | undefined {
	if (!edits || edits.length === 0) return undefined;
	const table = parseTable(pending.format, pending.text);
	const base = inferMapping(table, targetType, `file:${pending.fileName}`, knownProps);
	const byColumn = new Map(edits.map((e) => [e.column, e]));
	return {
		...base,
		columns: base.columns.map((col) => {
			const edit = byColumn.get(col.column);
			if (!edit) return col;
			const property = edit.property.trim();
			return {
				...col,
				include: edit.include,
				property: property.length > 0 ? property : col.property,
			};
		}),
	};
}

function parseEdits(value: unknown): readonly ImportMappingEdit[] | null {
	if (!Array.isArray(value)) return null;
	const edits: ImportMappingEdit[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const e = raw as Record<string, unknown>;
		if (typeof e.column !== "string" || typeof e.property !== "string") continue;
		edits.push({ column: e.column, property: e.property, include: e.include !== false });
	}
	return edits.length > 0 ? edits : null;
}

function requireSession() {
	const session = getActiveVaultSession();
	if (!session) throw new Error("import-export: no active vault session");
	return session;
}

function requireTargetType(targetType: unknown): string {
	if (typeof targetType !== "string" || targetType.trim().length === 0) {
		throw new Error("import-export: a target entity type is required");
	}
	return targetType.trim();
}

export function registerImportExportHandlers(options: ImportExportHandlersOptions): void {
	/** Resolve the applyDocUpdate for the active session, or undefined when the
	 *  host didn't wire a ydoc planter (tests). */
	const applyDocUpdateFor = (session: { vaultPath: string }) =>
		options.makeApplyDocUpdate?.(session.vaultPath);

	ipcMain.handle("import-export:pick-source", async (): Promise<ImportSourcePreview | null> => {
		const session = requireSession();
		const win = options.getDashboard();
		const dialogOptions = {
			title: "Import a data file",
			properties: ["openFile" as const],
			filters: [
				{
					name: "Data files",
					extensions: ["json", "jsonl", "ndjson", "csv", "md", "markdown", "html", "htm"],
				},
			],
		};
		const result = win
			? await dialog.showOpenDialog(win, dialogOptions)
			: await dialog.showOpenDialog(dialogOptions);
		if (result.canceled || result.filePaths.length === 0) return null;
		const path = result.filePaths[0];
		if (!path) return null;
		const format = formatFromExt(path);
		if (!format) {
			throw new Error("import-export: unsupported file type (expected .json/.jsonl/.csv/.md/.html)");
		}
		const text = await readFile(path, "utf8");
		const table = parseTable(format, text);
		pendingImport = { text, format, fileName: basename(path), vaultId: session.vaultId };
		return {
			fileName: basename(path),
			format,
			columns: table.columns,
			recordCount: table.records.length,
		};
	});

	/** Inferred column→property mapping for the picked source against a chosen
	 *  target type — the wizard's editable starting point (the user overrides
	 *  property + include per column, passed back to plan/run). */
	ipcMain.handle(
		"import-export:preview-mapping",
		async (_event, targetType: unknown): Promise<readonly ImportMappingPreview[]> => {
			const session = requireSession();
			const type = requireTargetType(targetType);
			const pending = requirePendingFor(session.vaultId);
			const table = parseTable(pending.format, pending.text);
			const mapping = inferMapping(
				table,
				type,
				`file:${pending.fileName}`,
				await knownPropsFor(session),
			);
			return mapping.columns.map((c) => ({
				column: c.column,
				property: c.property,
				valueType: c.valueType,
				include: c.include,
			}));
		},
	);

	ipcMain.handle(
		"import-export:plan",
		async (_event, targetType: unknown, edits: unknown): Promise<ImportPlan> => {
			const session = requireSession();
			const type = requireTargetType(targetType);
			const pending = requirePendingFor(session.vaultId);
			const knownProps = await knownPropsFor(session);
			const mapping = resolveMapping(pending, type, parseEdits(edits), knownProps);
			return planRecordsImport(session, pending.text, {
				format: pending.format,
				targetType: type,
				source: `file:${pending.fileName}`,
				now: Date.now(),
				importedBy: IMPORT_AUTHOR,
				knownProps,
				...(mapping ? { mapping } : {}),
			});
		},
	);

	ipcMain.handle(
		"import-export:run",
		async (_event, targetType: unknown, edits: unknown): Promise<ImportRunReport> => {
			const session = requireSession();
			const type = requireTargetType(targetType);
			const pending = requirePendingFor(session.vaultId);
			const knownProps = await knownPropsFor(session);
			const mapping = resolveMapping(pending, type, parseEdits(edits), knownProps);
			const applyDocUpdate = applyDocUpdateFor(session);
			const controller = new AbortController();
			activeRun = controller;
			const win = options.getDashboard();
			try {
				const report = await importRecordsIntoVault(
					session,
					pending.text,
					{
						format: pending.format,
						targetType: type,
						source: `file:${pending.fileName}`,
						now: Date.now(),
						importedBy: IMPORT_AUTHOR,
						knownProps,
						...(mapping ? { mapping } : {}),
					},
					{
						signal: controller.signal,
						onProgress: (done, total) => win?.webContents.send("import-export:progress", { done, total }),
					},
				);
				pendingImport = null;
				return report;
			} finally {
				if (activeRun === controller) activeRun = null;
			}
		},
	);

	// Cancel the in-flight run (doc 45 §Streaming). Safe to call when idle.
	ipcMain.handle("import-export:cancel", async (): Promise<void> => {
		activeRun?.abort();
	});

	ipcMain.handle("import-export:pick-obsidian", async (): Promise<ObsidianSourcePreview | null> => {
		const session = requireSession();
		const win = options.getDashboard();
		const dialogOptions = {
			title: "Choose an Obsidian vault folder",
			properties: ["openDirectory" as const],
		};
		const result = win
			? await dialog.showOpenDialog(win, dialogOptions)
			: await dialog.showOpenDialog(dialogOptions);
		if (result.canceled || result.filePaths.length === 0) return null;
		const folder = result.filePaths[0];
		if (!folder) return null;
		const { files, attachmentPaths } = await walkVault(folder);
		pendingObsidian = {
			folderName: basename(folder),
			root: folder,
			files,
			attachmentPaths,
			vaultId: session.vaultId,
		};
		return { folderName: basename(folder), noteCount: files.length };
	});

	ipcMain.handle(
		"import-export:run-obsidian",
		async (_event, targetType: unknown): Promise<ImportRunReport> => {
			const session = requireSession();
			const type = requireTargetType(targetType);
			const pending = requirePendingObsidianFor(session.vaultId);
			// Read only the attachment bytes a note actually references.
			const referenced = parseObsidianVault(
				pending.files,
				pending.attachmentPaths,
			).referencedAttachments;
			const attachments = await readReferencedAttachments(pending.root, referenced);
			const now = Date.now();
			const source = `obsidian:${pending.folderName}`;
			const applyDocUpdate = applyDocUpdateFor(session);
			const controller = new AbortController();
			activeRun = controller;
			const win = options.getDashboard();
			// try/finally so a throw mid-import can't strand the shared activeRun
			// controller (mirrors the source-file `run` handler).
			try {
				const report = await importObsidianVault(
					session,
					pending.files,
					{
						targetType: type,
						source,
						now,
						importedBy: IMPORT_AUTHOR,
						signal: controller.signal,
						onProgress: (done, total) => win?.webContents.send("import-export:progress", { done, total }),
						...(applyDocUpdate ? { applyDocUpdate } : {}),
					},
					attachments,
				);
				if (report.cancelled) {
					pendingObsidian = null;
					return {
						created: report.created,
						updated: report.updated,
						skipped: 0,
						failed: [],
						cancelled: true,
					};
				}
				// `.canvas` files in the vault → Whiteboard boards + edges (IE-5 tail).
				const canvasPaths = pending.attachmentPaths.filter((p) => /\.canvas$/i.test(p));
				const canvasBytes = await readReferencedAttachments(pending.root, canvasPaths);
				const canvasFiles: CanvasFile[] = [];
				for (const att of canvasBytes) {
					try {
						canvasFiles.push({
							path: att.path,
							name: basename(att.path).replace(/\.canvas$/i, ""),
							json: JSON.parse(Buffer.from(att.bytes).toString("utf8")),
						});
					} catch {
						// A non-JSON / corrupt .canvas is skipped, not fatal to the import.
					}
				}
				const canvas =
					canvasFiles.length > 0
						? await importObsidianCanvas(session, canvasFiles, { source, now, importedBy: IMPORT_AUTHOR })
						: { boardsCreated: 0, boardsUpdated: 0, edgesCreated: 0 };
				pendingObsidian = null;
				// The wizard shows a unified create/update/failed summary; map the
				// Obsidian report (which also carries link + file + board counts) onto it.
				return {
					created: report.created + report.filesCreated + canvas.boardsCreated + canvas.edgesCreated,
					updated: report.updated + canvas.boardsUpdated,
					skipped: 0,
					failed: [],
				};
			} finally {
				if (activeRun === controller) activeRun = null;
			}
		},
	);

	ipcMain.handle("import-export:pick-notion", async (): Promise<NotionSourcePreview | null> => {
		const session = requireSession();
		const win = options.getDashboard();
		// Notion's "Markdown & CSV" export is a .zip, but users often unzip it
		// first (or get a folder from a third-party tool). Accept both — same
		// shape as Anytype. macOS shows one combined picker; elsewhere the
		// file picker wins and a folder export is picked via "Open".
		const dialogOptions = {
			title: "Choose a Notion export (.zip or folder)",
			properties: ["openFile" as const, "openDirectory" as const],
			filters: [{ name: "Notion export", extensions: ["zip"] }],
		};
		const result = win
			? await dialog.showOpenDialog(win, dialogOptions)
			: await dialog.showOpenDialog(dialogOptions);
		if (result.canceled || result.filePaths.length === 0) return null;
		const archivePath = result.filePaths[0];
		if (!archivePath) return null;
		const files: NotionFile[] = [];
		const attachments: NotionAttachment[] = [];
		const picked = await stat(archivePath);
		if (picked.isDirectory()) {
			for (const entry of await walkExportFolder(archivePath, NOTION_ZIP_LIMITS)) {
				if (NOTION_TEXT_EXT.test(entry.path)) {
					files.push({ path: entry.path, text: Buffer.from(entry.bytes).toString("utf8") });
				} else {
					attachments.push({ path: entry.path, bytes: entry.bytes });
				}
			}
		} else {
			const bytes = new Uint8Array(await readFile(archivePath));
			for (const entry of readZip(bytes, NOTION_ZIP_LIMITS)) {
				if (NOTION_TEXT_EXT.test(entry.path)) {
					files.push({ path: entry.path, text: zipEntryText(entry) });
				} else {
					attachments.push({ path: entry.path, bytes: entry.bytes });
				}
			}
		}
		pendingNotion = {
			archiveName: basename(archivePath),
			files,
			attachments,
			vaultId: session.vaultId,
		};
		const pageCount = parseNotionExport(files).entities.length;
		return { archiveName: basename(archivePath), pageCount };
	});

	ipcMain.handle(
		"import-export:run-notion",
		async (_event, targetType: unknown): Promise<ImportRunReport> => {
			const session = requireSession();
			const type = requireTargetType(targetType);
			const pending = requirePendingNotionFor(session.vaultId);
			const applyDocUpdate = applyDocUpdateFor(session);
			const controller = new AbortController();
			activeRun = controller;
			const win = options.getDashboard();
			try {
				const report = await importNotionExport(
					session,
					pending.files,
					{
						targetType: type,
						source: `notion:${pending.archiveName}`,
						now: Date.now(),
						importedBy: IMPORT_AUTHOR,
						signal: controller.signal,
						onProgress: (done, total) => win?.webContents.send("import-export:progress", { done, total }),
						...(applyDocUpdate ? { applyDocUpdate } : {}),
					},
					pending.attachments,
				);
				pendingNotion = null;
				return {
					created: report.created + report.filesCreated,
					updated: report.updated,
					skipped: 0,
					failed: [],
					...(report.cancelled ? { cancelled: true } : {}),
				};
			} finally {
				if (activeRun === controller) activeRun = null;
			}
		},
	);

	ipcMain.handle("import-export:pick-anytype", async (): Promise<AnytypeSourcePreview | null> => {
		const session = requireSession();
		const win = options.getDashboard();
		// Anytype's desktop export lands as a folder or (with "zip archive" on)
		// a .zip — accept both. macOS shows one combined picker; elsewhere the
		// file picker wins and a folder export is picked via "Open".
		const dialogOptions = {
			title: "Choose an Anytype export (.zip or folder)",
			properties: ["openFile" as const, "openDirectory" as const],
			filters: [{ name: "Anytype export", extensions: ["zip"] }],
		};
		const result = win
			? await dialog.showOpenDialog(win, dialogOptions)
			: await dialog.showOpenDialog(dialogOptions);
		if (result.canceled || result.filePaths.length === 0) return null;
		const archivePath = result.filePaths[0];
		if (!archivePath) return null;
		const files: AnytypeFile[] = [];
		let attachmentPaths: string[] = [];
		let zipAttachments: AnytypeAttachment[] | null = null;
		const picked = await stat(archivePath);
		if (picked.isDirectory()) {
			// Folder pick: snapshot JSON text only; binary bytes are read lazily
			// at run time (only the paths the plan references).
			const walked = await walkAnytypeExportFolder(archivePath);
			files.push(...walked.files);
			attachmentPaths = walked.attachmentPaths;
		} else {
			const bytes = new Uint8Array(await readFile(archivePath));
			zipAttachments = [];
			for (const entry of readZip(bytes, ANYTYPE_ZIP_LIMITS)) {
				// Snapshot JSONs live per-kind folders or the root; binaries live in
				// `files/` (a stray .json there is a snapshot too — the parser decides).
				if (ANYTYPE_JSON_EXT.test(entry.path)) {
					files.push({ path: entry.path, text: zipEntryText(entry) });
				} else {
					zipAttachments.push({ path: entry.path, bytes: entry.bytes });
				}
			}
			attachmentPaths = zipAttachments.map((a) => a.path);
		}
		// Parse ONCE — the plan feeds the preview count here and the run later.
		const plan = parseAnytypeExport(files, attachmentPaths);
		const referenced = anytypeReferencedBinaryPaths(plan);
		pendingAnytype = {
			archiveName: basename(archivePath),
			files,
			plan,
			// Zip: the bytes are already in memory — keep only what the plan uses.
			attachments: zipAttachments ? zipAttachments.filter((a) => referenced.has(a.path)) : null,
			root: picked.isDirectory() ? archivePath : null,
			referencedPaths: [...referenced],
			vaultId: session.vaultId,
		};
		return { archiveName: basename(archivePath), objectCount: plan.entities.length };
	});

	ipcMain.handle(
		"import-export:run-anytype",
		async (_event, targetType: unknown): Promise<ImportRunReport> => {
			const session = requireSession();
			const type = requireTargetType(targetType);
			const pending = requirePendingAnytypeFor(session.vaultId);
			// Zip pick: referenced bytes already in memory. Folder pick: read only
			// the plan-referenced binaries now (bounded, root-confined).
			const attachments: readonly AnytypeAttachment[] =
				pending.attachments ??
				(pending.root ? await readReferencedAttachments(pending.root, pending.referencedPaths) : []);
			const applyDocUpdate = applyDocUpdateFor(session);
			const loadDocSnapshot = options.makeLoadDocSnapshot?.(session.vaultPath);
			const controller = new AbortController();
			activeRun = controller;
			const win = options.getDashboard();
			try {
				const report = await importAnytypeExport(
					session,
					pending.files,
					{
						targetType: type,
						// F-400 — keyed on the export's stable space id, not the
						// timestamped archive filename (which changes every re-export
						// and duplicated the whole space).
						source: anytypeImportSource(pending.plan, pending.archiveName),
						now: Date.now(),
						importedBy: IMPORT_AUTHOR,
						signal: controller.signal,
						onProgress: (done, total) => win?.webContents.send("import-export:progress", { done, total }),
						plan: pending.plan,
						...(applyDocUpdate ? { applyDocUpdate } : {}),
						...(loadDocSnapshot ? { loadDocSnapshot } : {}),
					},
					attachments,
				);
				pendingAnytype = null;
				// Surface missing media so the UI can explain why images didn't land —
				// Anytype's JSON export often omits binary file contents.
				const missing =
					report.filesMissingBinary > 0
						? [
								{
									externalId: "media",
									reason: `${report.filesMissingBinary} file(s) referenced but binaries were not in the export (Anytype JSON export typically omits file bytes)`,
									// F-395 — renderer-side i18n for the known media-missing
									// condition; `reason` above stays as the fallback text.
									reasonKey: "shell.settings.backupMigration.report.mediaMissing",
									reasonArgs: { count: report.filesMissingBinary },
								},
							]
						: [];
				return {
					created: report.created + report.filesCreated,
					updated: report.updated,
					skipped: report.skippedArchived + report.skippedSystem,
					failed: missing,
					...(report.cancelled ? { cancelled: true } : {}),
				};
			} finally {
				if (activeRun === controller) activeRun = null;
			}
		},
	);

	ipcMain.handle("import-export:export-vault", async (): Promise<{ path: string } | null> => {
		const session = requireSession();
		const win = options.getDashboard();
		const saveOptions = {
			title: "Export vault",
			defaultPath: `${session.vaultId}.bsbundle`,
			filters: [{ name: "Brainstorm bundle", extensions: ["bsbundle"] }],
		};
		const result = win
			? await dialog.showSaveDialog(win, saveOptions)
			: await dialog.showSaveDialog(saveOptions);
		if (result.canceled || !result.filePath) return null;
		const bytes = await exportVaultBundle(session, {
			scope: { kind: BundleExportScopeKind.WholeVault },
			now: Date.now(),
		});
		await writeFile(result.filePath, bytes);
		return { path: result.filePath };
	});
}

/** Test-only reset of the module-level pending slots. */
export function __resetPendingImportForTests(): void {
	pendingImport = null;
	pendingObsidian = null;
	pendingNotion = null;
	pendingAnytype = null;
	activeRun = null;
}

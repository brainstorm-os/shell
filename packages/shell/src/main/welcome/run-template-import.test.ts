import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIST_ENTITY_TYPE } from "@brainstorm-os/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { makeEnvelope } from "../../ipc/envelope";
import { handleYDocEnvelope } from "../../workers/ydoc/index";
import { base64ToBytes } from "../credentials/crypto";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import { runTemplateImport } from "./run-template-import";
import { TemplateImportOutcome, templateCollectionId } from "./seed-template";
import { buildTemplateManifest } from "./template-codec";
import { readTemplateImportVersion } from "./template-import-store";

const NOW = 1_700_000_000_000;
// A *valid* Lexical state — the real plant path parses it into a headless
// editor, so an empty/partial root would throw (the fake-deps unit test
// doesn't validate; this in-process one does).
const body = {
	root: {
		type: "root",
		format: "",
		indent: 0,
		direction: null,
		version: 1,
		children: [
			{
				type: "paragraph",
				format: "",
				indent: 0,
				direction: null,
				version: 1,
				children: [
					{ type: "text", text: "Hello", format: 0, style: "", mode: "normal", detail: 0, version: 1 },
				],
			},
		],
	},
} as never;

function manifest() {
	return buildTemplateManifest({
		id: "study",
		name: "Study",
		entities: [
			{ id: "s_task", type: "brainstorm/Task/v1", properties: { name: "Read ch.1" } },
			{ id: "s_note", type: "io.brainstorm.notes/Note/v1", properties: { title: "Notes" }, body },
		],
	});
}

function ydocApply(vaultPath: string) {
	return async (entityId: string, updateB64: string): Promise<void> => {
		const reply = await handleYDocEnvelope(
			makeEnvelope({
				msg: `w${entityId}`,
				app: "io.brainstorm.shell",
				service: "ydoc",
				method: "applyUpdate",
				args: [{ vaultPath, entityId, updateB64 }],
				caps: [],
			}),
		);
		if (!reply.ok) throw new Error("ydoc applyUpdate failed");
	};
}

async function loadDocBytes(vaultPath: string, entityId: string): Promise<Uint8Array> {
	const reply = await handleYDocEnvelope(
		makeEnvelope({
			msg: `l${entityId}`,
			app: "io.brainstorm.shell",
			service: "ydoc",
			method: "load",
			args: [{ vaultPath, entityId }],
			caps: [],
		}),
	);
	if (!reply.ok) throw new Error("ydoc load failed");
	return base64ToBytes((reply.value as { snapshotB64: string }).snapshotB64);
}

describe("runTemplateImport (in-process, real entities repo + ydoc store)", () => {
	let vaultDir: string;
	let stores: DataStores;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-template-"));
		stores = new DataStores(vaultDir);
	});
	afterEach(async () => {
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("imports the entities + the parent Collection and plants the note body", async () => {
		const result = await runTemplateImport({
			session: { vaultPath: vaultDir, dataStores: stores },
			manifest: manifest(),
			applyDocUpdate: ydocApply(vaultDir),
			now: NOW,
		});

		expect(result.outcome).toBe(TemplateImportOutcome.Imported);
		expect(result.created).toBe(3); // 2 entities + 1 Collection
		expect(result.planted).toBe(1);
		expect(result.errors).toEqual([]);

		const repo = new EntitiesRepository(await stores.open("entities"));
		expect(repo.get("s_task")).not.toBeNull();
		const collection = repo.get(templateCollectionId("study"));
		expect(collection?.type).toBe(LIST_ENTITY_TYPE);

		// The note body round-trips through the on-disk ydoc store.
		const bytes = await loadDocBytes(vaultDir, "s_note");
		const doc = new Y.Doc();
		Y.applyUpdate(doc, bytes);
		expect(Y.encodeStateAsUpdate(doc).byteLength).toBeGreaterThan(16);
		doc.destroy();
	});

	it("stamps the template so a second import is a no-op (no duplicate rows)", async () => {
		const deps = {
			session: { vaultPath: vaultDir, dataStores: stores },
			manifest: manifest(),
			applyDocUpdate: ydocApply(vaultDir),
			now: NOW,
		};
		await runTemplateImport(deps);
		expect(await readTemplateImportVersion(vaultDir, "study")).toBe(1);

		const repo = new EntitiesRepository(await stores.open("entities"));
		const countAfterFirst = repo.query({}).length;

		const second = await runTemplateImport(deps);
		expect(second.outcome).toBe(TemplateImportOutcome.AlreadyImported);
		expect(repo.query({}).length).toBe(countAfterFirst); // no duplicates
	});

	it("imports a second, distinct template independently (per-template stamp)", async () => {
		const session = { vaultPath: vaultDir, dataStores: stores };
		await runTemplateImport({
			session,
			manifest: manifest(),
			applyDocUpdate: ydocApply(vaultDir),
			now: NOW,
		});
		const other = buildTemplateManifest({
			id: "writing",
			name: "Writing",
			entities: [{ id: "w_doc", type: "io.brainstorm.notes/Note/v1", properties: { title: "Draft" } }],
		});
		const result = await runTemplateImport({
			session,
			manifest: other,
			applyDocUpdate: ydocApply(vaultDir),
			now: NOW,
		});
		expect(result.outcome).toBe(TemplateImportOutcome.Imported);
		const repo = new EntitiesRepository(await stores.open("entities"));
		expect(repo.get("w_doc")).not.toBeNull();
		expect(repo.get(templateCollectionId("writing"))).not.toBeNull();
	});
});

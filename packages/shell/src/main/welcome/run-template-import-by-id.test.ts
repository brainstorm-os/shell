/**
 * In-process pipeline test for `runTemplateImportById` (Welcome-2 / 9.3.5.V
 * 7d) — the registry-resolving import path the `welcome:import-template` IPC
 * handler runs. Drives a REAL registry template through a real `DataStores` +
 * the ydoc worker (no keystore / master key), proving id → manifest → import
 * lands entities + the parent Collection in `entities.db` and plants note
 * bodies, plus the fail-closed unknown-id branch the handler relies on.
 */

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
import { runTemplateImportById } from "./run-template-import";
import { TemplateImportOutcome, templateCollectionId } from "./seed-template";
import { templateById } from "./template-registry";

const NOW = 1_700_000_000_000;
const TEMPLATE_ID = "personal-knowledge"; // three notes with cross-linking bodies

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

describe("runTemplateImportById (in-process, real entities repo + ydoc store)", () => {
	let vaultDir: string;
	let stores: DataStores;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-tmpl-byid-"));
		stores = new DataStores(vaultDir);
	});
	afterEach(async () => {
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("resolves a registry id, imports its entities + parent Collection, and plants note bodies", async () => {
		const result = await runTemplateImportById({
			session: { vaultPath: vaultDir, dataStores: stores },
			templateId: TEMPLATE_ID,
			applyDocUpdate: ydocApply(vaultDir),
			now: NOW,
		});

		expect(result).not.toBeNull();
		expect(result?.outcome).toBe(TemplateImportOutcome.Imported);

		const manifest = templateById(TEMPLATE_ID)?.build(NOW);
		const entityCount = manifest?.entities.length ?? 0;
		// created = the manifest's entities + the parent Collection.
		expect(result?.created).toBe(entityCount + 1);
		expect(result?.errors).toEqual([]);

		const repo = new EntitiesRepository(await stores.open("entities"));
		for (const ent of manifest?.entities ?? []) {
			expect(repo.get(ent.id)).not.toBeNull();
		}
		const collection = repo.get(templateCollectionId(TEMPLATE_ID));
		expect(collection?.type).toBe(LIST_ENTITY_TYPE);

		// A note body round-trips through the on-disk ydoc store.
		const firstWithBody = manifest?.entities.find((e) => e.body);
		expect(firstWithBody).toBeDefined();
		const bytes = await loadDocBytes(vaultDir, firstWithBody?.id ?? "");
		const doc = new Y.Doc();
		Y.applyUpdate(doc, bytes);
		expect(Y.encodeStateAsUpdate(doc).byteLength).toBeGreaterThan(16);
		doc.destroy();
	});

	it("returns null for an unknown id (the handler's fail-closed branch) and writes nothing", async () => {
		const result = await runTemplateImportById({
			session: { vaultPath: vaultDir, dataStores: stores },
			templateId: "no-such-template",
			applyDocUpdate: ydocApply(vaultDir),
			now: NOW,
		});
		expect(result).toBeNull();
		const repo = new EntitiesRepository(await stores.open("entities"));
		expect(repo.query({}).length).toBe(0);
	});
});

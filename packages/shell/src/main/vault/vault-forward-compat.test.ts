/**
 * Stage 10.8 — forward-compatibility contract.
 *
 * The freeze commits to forward-compat: a 1.0 reader must survive an
 * unknown future-minor field in `vault.json` (and in the vault-properties
 * Y.Doc) without dropping or corrupting it. These tests pin the
 * persistence-side promise.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTestDir } from "../test-support/remove-test-dir";

let USER_DATA_DIR = "";

vi.mock("electron", () => ({
	app: { getPath: () => USER_DATA_DIR },
}));

describe("vault.json + vault-properties forward-compat", () => {
	let workDir: string;
	let vaultPath: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "brainstorm-vault-fwdcompat-"));
		USER_DATA_DIR = workDir;
		vaultPath = join(workDir, "vault");
	});

	afterEach(async () => {
		await removeTestDir(workDir);
	});

	async function freshShell(): Promise<{
		createVault: typeof import("./vault").createVault;
		openVault: typeof import("./vault").openVault;
		setSyncRelayConfig: typeof import("./vault").setSyncRelayConfig;
		closeActiveVaultSession: typeof import("./session").closeActiveVaultSession;
	}> {
		vi.resetModules();
		const sqliteMod = await import("../storage/sqlite");
		sqliteMod.__setSqlcipherDriverForTests(null);
		const atRestMod = await import("../storage/at-rest-mode");
		atRestMod.__resetAtRestProbeForTests();
		const vault = await import("./vault");
		const session = await import("./session");
		return {
			createVault: vault.createVault,
			openVault: vault.openVault,
			setSyncRelayConfig: vault.setSyncRelayConfig,
			closeActiveVaultSession: session.closeActiveVaultSession,
		};
	}

	it("unknown forward field on vault.json survives openVault round-trip", async () => {
		const { createVault, openVault, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "v", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		const file = join(vaultPath, "vault.json");
		const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		parsed.future_v2_only_field = { nested: "preserved" };
		await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
		const shell2 = await freshShell();
		await shell2.openVault(vaultPath, { keystore: { forceInsecure: true } });
		const after = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		expect(after.future_v2_only_field).toEqual({ nested: "preserved" });
		shell2.closeActiveVaultSession();
	});

	it("unknown forward field survives setSyncRelayConfig mutation", async () => {
		const { createVault, setSyncRelayConfig, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "v", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		const file = join(vaultPath, "vault.json");
		const before = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		before.future_v2_only_field = "preserved";
		await writeFile(file, `${JSON.stringify(before, null, 2)}\n`, "utf8");
		await setSyncRelayConfig(vaultPath, {
			url: "wss://relay.example.invalid/",
			addedAt: 1_800_000_000_000,
		});
		const after = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		expect(after.future_v2_only_field).toBe("preserved");
		expect(after.syncRelay).toEqual({
			url: "wss://relay.example.invalid/",
			addedAt: 1_800_000_000_000,
		});
	});

	it("vault-properties Y.Doc survives an unknown meta.* key on round-trip", async () => {
		const { YDocStore } = await import("../storage/ydoc-store");
		const { VaultPropertiesStore, VAULT_PROPERTIES_DOC_ID } = await import(
			"./vault-properties-store"
		);
		const docsDir = join(vaultPath, "data", "docs");
		const yStoreA = new YDocStore("ignored", { docsDir });
		const storeA = await VaultPropertiesStore.open(yStoreA);
		const yDocA = storeA.yDoc;
		const meta = yDocA.getMap("meta");
		meta.set("future_key_v2", "preserved-forward");
		await storeA.flush();
		await storeA.close();

		const yStoreB = new YDocStore("ignored", { docsDir });
		const { doc } = await yStoreB.load(VAULT_PROPERTIES_DOC_ID);
		const reloadedMeta = doc.getMap<unknown>("meta");
		expect(reloadedMeta.get("future_key_v2")).toBe("preserved-forward");
	});
});

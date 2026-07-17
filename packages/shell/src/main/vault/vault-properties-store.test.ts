import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YDocStore } from "../storage/ydoc-store";
import { removeTestDir } from "../test-support/remove-test-dir";
import { VAULT_PROPERTIES_DOC_ID, VaultPropertiesStore } from "./vault-properties-store";

describe("VaultPropertiesStore", () => {
	let vaultDir: string;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-vp-store-"));
	});

	afterEach(async () => {
		await removeTestDir(vaultDir);
	});

	it("opens with the canonical doc id and exposes a DevicesStore", async () => {
		const yStore = new YDocStore(vaultDir);
		const store = await VaultPropertiesStore.open(yStore);
		try {
			const devices = store.devices();
			expect(devices.list()).toEqual([]);
			expect(VAULT_PROPERTIES_DOC_ID).toBe("brainstorm-VaultProperties");
		} finally {
			await store.close();
		}
	});

	it("persists add-device records across open / close / re-open", async () => {
		const yStore = new YDocStore(vaultDir);
		const opened = await VaultPropertiesStore.open(yStore);
		opened.devices().add({
			deviceEd25519Pub: "pub-1",
			deviceX25519Pub: "x-1",
			deviceLabel: "Laptop",
			addedAt: 1_700_000_000,
			addedBy: "user-pub",
			sig: "sig-1",
		});
		await opened.flush();
		await opened.close();

		const yStore2 = new YDocStore(vaultDir);
		const reopened = await VaultPropertiesStore.open(yStore2);
		try {
			const records = reopened.devices().list();
			expect(records.length).toBe(1);
			expect(records[0]?.deviceEd25519Pub).toBe("pub-1");
		} finally {
			await reopened.close();
		}
	});

	it("devices() returns the same instance across calls", async () => {
		const yStore = new YDocStore(vaultDir);
		const store = await VaultPropertiesStore.open(yStore);
		try {
			expect(store.devices()).toBe(store.devices());
		} finally {
			await store.close();
		}
	});
});

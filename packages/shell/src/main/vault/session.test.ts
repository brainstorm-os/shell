import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREDENTIALS_FILENAME } from "../credentials/store";
import { PropertiesStore } from "../properties/properties-store";
import { EntitiesRepository } from "../storage/entities-repo";
import { removeTestDir } from "../test-support/remove-test-dir";
import { ROOT_FOLDER_ENTITY_ID, ROOT_FOLDER_TYPE, VaultSession } from "./session";

describe("VaultSession", () => {
	let vaultDir: string;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-vsession-"));
	});

	afterEach(async () => {
		await removeTestDir(vaultDir);
	});

	it("create() provisions identity + master via the insecure backend", async () => {
		const session = await VaultSession.create({
			vaultId: "vlt_test",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		try {
			expect(session.identity.publicKey.length).toBe(32);
			expect(session.identity.publicKeyBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
			expect(session.identity.fingerprint).toMatch(/^ed25519:[0-9a-f]{16}$/);
			expect(session.backend.name).toBe("insecure-dev");
			expect(session.backend.isInsecure).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("open() recovers the same identity from the keystore", async () => {
		const created = await VaultSession.create({
			vaultId: "vlt_recover",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		const originalFingerprint = created.identity.fingerprint;
		const originalPubKey = created.identity.publicKeyBase64;
		created.dispose();

		const reopened = await VaultSession.open("vlt_recover", vaultDir, {
			forceInsecure: true,
		});
		try {
			expect(reopened.identity.fingerprint).toBe(originalFingerprint);
			expect(reopened.identity.publicKeyBase64).toBe(originalPubKey);
		} finally {
			reopened.dispose();
		}
	});

	it("open() with a mismatched expected public key rejects (tamper detection)", async () => {
		const created = await VaultSession.create({
			vaultId: "vlt_tamper",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		created.dispose();
		const fakePublicKey = Buffer.from(new Uint8Array(32)).toString("base64");
		await expect(
			VaultSession.open("vlt_tamper", vaultDir, {
				forceInsecure: true,
				expectedPublicKeyBase64: fakePublicKey,
			}),
		).rejects.toThrow(/identity public key/i);
	});

	it("open() fails if identity key is missing from the keystore", async () => {
		await expect(VaultSession.open("vlt_missing", vaultDir, { forceInsecure: true })).rejects.toThrow(
			/identity key missing/i,
		);
	});

	it("signPayload + verify round-trips with the session's identity", async () => {
		const session = await VaultSession.create({
			vaultId: "vlt_sign",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		try {
			const payload = new TextEncoder().encode("hello sig");
			const signature = session.signPayload(payload);
			const { verifySignature } = await import("../credentials/identity");
			expect(verifySignature(session.identity.publicKey, payload, signature)).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("credentials CRUD goes through the session", async () => {
		const session = await VaultSession.create({
			vaultId: "vlt_cred",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		try {
			await session.setCredential(
				{ app: "shell", key: "ai:provider:anthropic" },
				new TextEncoder().encode("sk-abc"),
			);
			const got = await session.getCredential({ app: "shell", key: "ai:provider:anthropic" });
			expect(new TextDecoder().decode(got ?? new Uint8Array())).toBe("sk-abc");
			const list = await session.listCredentials("shell");
			expect(list.map((m) => m.key)).toEqual(["ai:provider:anthropic"]);
			expect(await session.deleteCredential({ app: "shell", key: "ai:provider:anthropic" })).toBe(
				true,
			);
			expect(await session.getCredential({ app: "shell", key: "ai:provider:anthropic" })).toBeNull();
		} finally {
			session.dispose();
		}
	});

	it("credentials persist across dispose + reopen", async () => {
		const first = await VaultSession.create({
			vaultId: "vlt_persist",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		await first.setCredential({ app: "shell", key: "k" }, new TextEncoder().encode("survives"));
		first.dispose();
		const second = await VaultSession.open("vlt_persist", vaultDir, { forceInsecure: true });
		try {
			const got = await second.getCredential({ app: "shell", key: "k" });
			expect(new TextDecoder().decode(got ?? new Uint8Array())).toBe("survives");
			// File should exist on disk encrypted.
			const raw = await readFile(join(vaultDir, "shell", CREDENTIALS_FILENAME), "utf8");
			expect(raw).not.toContain("survives");
		} finally {
			second.dispose();
		}
	});

	it("meta reports the active backend + identity + device X25519", async () => {
		const session = await VaultSession.create({
			vaultId: "vlt_meta",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		try {
			const meta = session.meta;
			expect(meta.vaultId).toBe("vlt_meta");
			expect(meta.vaultPath).toBe(vaultDir);
			expect(meta.backend).toBe("insecure-dev");
			expect(meta.backendIsInsecure).toBe(true);
			expect(meta.identity.fingerprint).toMatch(/^ed25519:/);
			expect(meta.deviceX25519.publicKeyBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
			expect(meta.deviceX25519.publicKeyBase64).toBe(session.deviceX25519.publicKeyBase64);
			expect(meta.deviceEd25519.publicKeyBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
			expect(meta.deviceEd25519.publicKeyBase64).toBe(session.deviceEd25519.publicKeyBase64);
			// All three pubkeys are independent primitives.
			expect(meta.deviceEd25519.publicKeyBase64).not.toBe(meta.deviceX25519.publicKeyBase64);
			expect(meta.deviceEd25519.publicKeyBase64).not.toBe(session.identity.publicKeyBase64);
		} finally {
			session.dispose();
		}
	});

	describe("device Ed25519 keypair (Stage 10.5a)", () => {
		it("create() provisions a device-Ed25519 keypair alongside the other secrets", async () => {
			const session = await VaultSession.create({
				vaultId: "vlt_deved",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			try {
				expect(session.deviceEd25519.publicKey.length).toBe(32);
				expect(session.deviceEd25519.publicKeyBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
			} finally {
				session.dispose();
			}
		});

		it("open() recovers the same device-Ed25519 pubkey from the keystore", async () => {
			const created = await VaultSession.create({
				vaultId: "vlt_deved_recover",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			const originalPub = created.deviceEd25519.publicKeyBase64;
			created.dispose();
			const reopened = await VaultSession.open("vlt_deved_recover", vaultDir, {
				forceInsecure: true,
			});
			try {
				expect(reopened.deviceEd25519.publicKeyBase64).toBe(originalPub);
			} finally {
				reopened.dispose();
			}
		});

		it("open() lazy-mints the device-Ed25519 keypair for a pre-10.5a vault", async () => {
			const created = await VaultSession.create({
				vaultId: "vlt_deved_legacy",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			await created.backend.deleteSecret("vlt_deved_legacy", "device-ed25519");
			created.dispose();

			const reopened = await VaultSession.open("vlt_deved_legacy", vaultDir, {
				forceInsecure: true,
			});
			const lazyMintedPub = reopened.deviceEd25519.publicKeyBase64;
			reopened.dispose();

			const reopenedAgain = await VaultSession.open("vlt_deved_legacy", vaultDir, {
				forceInsecure: true,
			});
			try {
				expect(reopenedAgain.deviceEd25519.publicKeyBase64).toBe(lazyMintedPub);
			} finally {
				reopenedAgain.dispose();
			}
		});

		it("signWithDeviceKey signs and verifies with the device pubkey", async () => {
			const { verifyDeviceSignature } = await import("../credentials/device-ed25519");
			const session = await VaultSession.create({
				vaultId: "vlt_devsign",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			try {
				const payload = new TextEncoder().encode("test/v1/pair");
				const sig = session.signWithDeviceKey(payload);
				expect(verifyDeviceSignature(session.deviceEd25519.publicKey, payload, sig)).toBe(true);
			} finally {
				session.dispose();
			}
		});

		it("signWithDeviceKey throws after dispose (secret zeroed)", async () => {
			const session = await VaultSession.create({
				vaultId: "vlt_devsign_dispose",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			session.dispose();
			expect(() => session.signWithDeviceKey(new Uint8Array([1, 2, 3]))).toThrow(/disposed/);
		});
	});

	describe("device X25519 keypair (Stage 10.2)", () => {
		it("create() provisions a device X25519 pubkey alongside identity + master", async () => {
			const session = await VaultSession.create({
				vaultId: "vlt_devkey",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			try {
				expect(session.deviceX25519.publicKey.length).toBe(32);
				expect(session.deviceX25519.publicKeyBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
				// Different from the Ed25519 identity pub — separate primitives.
				expect(session.deviceX25519.publicKeyBase64).not.toBe(session.identity.publicKeyBase64);
			} finally {
				session.dispose();
			}
		});

		it("open() recovers the same device X25519 pubkey from the keystore", async () => {
			const created = await VaultSession.create({
				vaultId: "vlt_devkey_recover",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			const originalDevicePub = created.deviceX25519.publicKeyBase64;
			created.dispose();

			const reopened = await VaultSession.open("vlt_devkey_recover", vaultDir, {
				forceInsecure: true,
			});
			try {
				expect(reopened.deviceX25519.publicKeyBase64).toBe(originalDevicePub);
			} finally {
				reopened.dispose();
			}
		});

		it("open() lazy-mints the device X25519 keypair for a pre-10.2 vault (missing entry)", async () => {
			// Simulate a vault created before 10.2: identity + master live in
			// the keystore but no `device-x25519` entry exists yet. Modelled
			// by deleting the entry after a fresh create.
			const created = await VaultSession.create({
				vaultId: "vlt_devkey_legacy",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			await created.backend.deleteSecret("vlt_devkey_legacy", "device-x25519");
			created.dispose();

			const reopened = await VaultSession.open("vlt_devkey_legacy", vaultDir, {
				forceInsecure: true,
			});
			const lazyMintedPub = reopened.deviceX25519.publicKeyBase64;
			reopened.dispose();

			// The persisted lazy-mint survives the next open (idempotent).
			const reopenedAgain = await VaultSession.open("vlt_devkey_legacy", vaultDir, {
				forceInsecure: true,
			});
			try {
				expect(reopenedAgain.deviceX25519.publicKeyBase64).toBe(lazyMintedPub);
			} finally {
				reopenedAgain.dispose();
			}
		});

		it("unwrapMemberWrap recovers a DEK addressed to this device", async () => {
			const session = await VaultSession.create({
				vaultId: "vlt_devkey_unwrap",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			try {
				const { generateSymmetricKey } = await import("../credentials/crypto");
				const { wrapDekForRecipient } = await import("../credentials/member-wraps");
				const dek = generateSymmetricKey();
				const wrap = wrapDekForRecipient(dek, session.deviceX25519.publicKey, "ent_unwrap");
				const recovered = session.unwrapMemberWrap(wrap, "ent_unwrap");
				expect(Buffer.compare(recovered, dek)).toBe(0);
			} finally {
				session.dispose();
			}
		});

		it("unwrapMemberWrap fails after dispose (secret zeroed)", async () => {
			const session = await VaultSession.create({
				vaultId: "vlt_devkey_disposed",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			const { generateSymmetricKey } = await import("../credentials/crypto");
			const { wrapDekForRecipient } = await import("../credentials/member-wraps");
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, session.deviceX25519.publicKey, "ent_x");
			session.dispose();
			expect(() => session.unwrapMemberWrap(wrap, "ent_x")).toThrow(/disposed/);
		});
	});

	it("dispose() makes credential operations throw", async () => {
		const session = await VaultSession.create({
			vaultId: "vlt_disposed",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		session.dispose();
		await expect(
			session.setCredential({ app: "shell", key: "k" }, new Uint8Array([1])),
		).rejects.toThrow(/disposed/);
		expect(() => session.signPayload(new Uint8Array([1]))).toThrow(/disposed/);
	});

	it("dispose() is idempotent", async () => {
		const session = await VaultSession.create({
			vaultId: "vlt_idem",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		session.dispose();
		expect(() => session.dispose()).not.toThrow();
	});

	it("propertiesStore(): a transient open failure does not poison later calls", async () => {
		// Regression: the cached in-flight promise used to keep a rejected
		// PropertiesStore.open forever, so EVERY subsequent caller (incl.
		// the `properties.list()` broker handler) rejected for the rest of
		// the session — the Notes picker then stayed empty with no recovery.
		const session = await VaultSession.create({
			vaultId: "vlt_props_retry",
			vaultPath: vaultDir,
			forceInsecure: true,
		});
		try {
			const original = PropertiesStore.open.bind(PropertiesStore);
			const spy = vi
				.spyOn(PropertiesStore, "open")
				.mockRejectedValueOnce(new Error("transient ydoc read error"))
				.mockImplementation((store, opts) => original(store, opts));

			await expect(session.propertiesStore()).rejects.toThrow("transient ydoc read error");
			// The fix: the next call retries instead of returning the
			// poisoned rejected promise.
			const store = await session.propertiesStore();
			expect(store).toBeDefined();
			expect(store.snapshot().properties).toEqual({});
			expect(spy).toHaveBeenCalledTimes(2);
			spy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	describe("ensureRootFolder()", () => {
		it("creates the canonical root Folder on first call", async () => {
			const session = await VaultSession.create({
				vaultId: "vlt_root_create",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			try {
				const r = await session.ensureRootFolder(4242);
				expect(r).toEqual({ rootId: ROOT_FOLDER_ENTITY_ID, created: true });

				const repo = new EntitiesRepository(await session.dataStores.open("entities"));
				const row = repo.get(ROOT_FOLDER_ENTITY_ID);
				expect(row?.type).toBe(ROOT_FOLDER_TYPE);
				expect(row?.properties).toMatchObject({ name: "Vault", members: [] });
				expect(row?.createdAt).toBe(4242);
			} finally {
				session.dispose();
			}
		});

		it("is idempotent — a second call resolves without recreating", async () => {
			const session = await VaultSession.create({
				vaultId: "vlt_root_idem",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			try {
				const first = await session.ensureRootFolder(1);
				expect(first.created).toBe(true);
				const second = await session.ensureRootFolder(2);
				expect(second).toEqual({ rootId: ROOT_FOLDER_ENTITY_ID, created: false });
			} finally {
				session.dispose();
			}
		});

		it("does not clobber a user-edited root row on a later open", async () => {
			const session = await VaultSession.create({
				vaultId: "vlt_root_noclobber",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			try {
				await session.ensureRootFolder(10);
				const repo = new EntitiesRepository(await session.dataStores.open("entities"));
				repo.update(ROOT_FOLDER_ENTITY_ID, { name: "Renamed", members: ["fld_x"] }, 20);

				const again = await session.ensureRootFolder(30);
				expect(again.created).toBe(false);
				const row = repo.get(ROOT_FOLDER_ENTITY_ID);
				expect(row?.properties).toMatchObject({ name: "Renamed", members: ["fld_x"] });
			} finally {
				session.dispose();
			}
		});

		it("survives recreate-then-reopen: the row persists, second open is a no-op", async () => {
			const created = await VaultSession.create({
				vaultId: "vlt_root_persist",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			const r1 = await created.ensureRootFolder(100);
			expect(r1.created).toBe(true);
			created.dispose();

			const reopened = await VaultSession.open("vlt_root_persist", vaultDir, {
				forceInsecure: true,
			});
			try {
				const r2 = await reopened.ensureRootFolder(200);
				expect(r2.created).toBe(false);
				const repo = new EntitiesRepository(await reopened.dataStores.open("entities"));
				expect(repo.get(ROOT_FOLDER_ENTITY_ID)?.createdAt).toBe(100);
			} finally {
				reopened.dispose();
			}
		});

		it("is fail-safe — a disposed session does not throw the vault-open path", async () => {
			const session = await VaultSession.create({
				vaultId: "vlt_root_failsafe",
				vaultPath: vaultDir,
				forceInsecure: true,
			});
			session.dispose();
			await expect(session.ensureRootFolder()).rejects.toThrow(/disposed/i);
		});
	});
});

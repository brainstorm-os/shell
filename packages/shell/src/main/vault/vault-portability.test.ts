/**
 * Iteration 13.5 — vault directory portability round-trip.
 *
 * Proves a vault is portable across machines/platforms: a vault written on
 * one host, tarred, moved to a fresh location (simulating macOS → Linux),
 * and re-opened recovers its identity + all data byte-faithfully. The
 * `.bsbundle` export (IE-1) isn't built yet, so portability here is the
 * **raw on-disk vault directory** round-trip.
 *
 * Keystore choice matters: the OS keyring is intentionally NOT portable
 * (its secrets live in the platform credential store, not the vault dir),
 * so the test uses the insecure-dev backend, whose secrets persist inside
 * `<vaultPath>/shell/insecure-keystore.json` — i.e. they travel WITH the
 * directory. (The passphrase backend is equally portable; same
 * `<vaultPath>/shell/` home.) That a portable keystore even exists is what
 * makes a directory-only move recover the master key + identity at all.
 *
 * What the round-trip asserts after re-opening at the NEW path:
 *   - the Ed25519 identity recovers (same public key + same fingerprint);
 *   - the master key unlocks (credentials sealed under it decrypt);
 *   - entities.db is byte-faithful (same rows, same properties);
 *   - the Yjs doc snapshot/tail survives (same doc state, CRC intact);
 *   - nothing in the vault dir baked an absolute path tied to the old host.
 *
 * Runs in-process under bun:sqlite. A genuine cross-OS execution (writing
 * on a macOS runner, untarring + opening on a Linux runner) is a CI matrix
 * concern; this exercises the format + path-separator normalisation that
 * such a run depends on.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EntitiesRepository } from "../storage/entities-repo";
import { removeTestDir } from "../test-support/remove-test-dir";
import { packDirToTar, unpackTarToDir } from "./__fixtures__/tar";

let USER_DATA_DIR = "";

// The registry lives under userData; vault.ts reads it via app.getPath. Point
// it at a temp dir so re-opening at the new path registers cleanly without
// touching the real home registry.
vi.mock("electron", () => ({
	app: { getPath: () => USER_DATA_DIR },
}));

const INSECURE = { keystore: { forceInsecure: true } } as const;
const ACTOR = "test.portability";

async function loadVaultModule() {
	// session.ts holds module-scoped `active`; re-import per round so the
	// move starts from a clean active-session slate. Mirrors vault-at-rest.
	vi.resetModules();
	const vaultMod = await import("./vault");
	const sessionMod = await import("./session");
	return { ...vaultMod, ...sessionMod };
}

/** Capture a Yjs update for a single mutation (same idiom as ydoc-store.test). */
function captureUpdate(doc: Y.Doc, mutate: () => void): Uint8Array {
	let captured: Uint8Array | null = null;
	const handler = (update: Uint8Array) => {
		captured = update;
	};
	doc.on("update", handler);
	try {
		mutate();
	} finally {
		doc.off("update", handler);
	}
	if (!captured) throw new Error("expected an update");
	return captured;
}

describe("vault directory portability round-trip", () => {
	let workDir: string;
	let sourceVault: string;
	let movedVault: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "brainstorm-portability-"));
		USER_DATA_DIR = join(workDir, "userData-source");
		sourceVault = join(workDir, "Brainstorm", "MyVault");
		movedVault = join(workDir, "moved", "Relocated Vault");
	});

	afterEach(async () => {
		await removeTestDir(workDir);
	});

	it("recovers identity, master key, entities + Yjs doc after a tar → untar move", async () => {
		// ── 1. Create + seed the source vault, then CLOSE it. ──────────────
		const seededEntityId = "ent_portability_seed";
		const docEntityId = "ent_portability_doc";
		let originalFingerprint = "";
		let originalPublicKey = "";
		let vaultId = "";

		{
			const { createVault, getActiveVaultSession, closeActiveVaultSession } = await loadVaultModule();
			const entry = await createVault({ name: "MyVault", path: sourceVault, ...INSECURE });
			vaultId = entry.id;
			const session = getActiveVaultSession();
			if (!session) throw new Error("expected an active session after create");
			originalFingerprint = session.identity.fingerprint;
			originalPublicKey = session.identity.publicKeyBase64;

			// Seed an entity row into entities.db.
			const db = await session.dataStores.open("entities");
			new EntitiesRepository(db).create({
				id: seededEntityId,
				type: "test/Note/v1",
				properties: { title: "Portable note", count: 42, tags: ["a", "b"] },
				createdBy: ACTOR,
				now: 1_700_000_000_000,
				dekId: null,
			});

			// Seed a credential sealed under the master key — proving the key
			// unlocks after the move means this round-trips to plaintext.
			await session.setCredential(
				{ app: "test", key: "token" },
				new TextEncoder().encode("super-secret-value"),
			);

			// Seed a Yjs doc. Both mutations run inside one `Y.transact` so
			// they coalesce into a single update (two separate top-level
			// mutations would fire two update events; the tail then holds only
			// the last). One update keeps the round-trip assertion exact.
			const writer = new Y.Doc();
			const update = captureUpdate(writer, () => {
				Y.transact(writer, () => {
					writer.getText("body").insert(0, "hello portable world");
					writer.getMap("meta").set("kind", "demo");
				});
			});
			await session.ydocStore.appendUpdate(docEntityId, update);

			closeActiveVaultSession();
		}

		// ── 2. Tar the vault directory to a buffer (the "move" wire). ──────
		const archive = await packDirToTar(sourceVault);
		expect(archive.length).toBeGreaterThan(0);

		// Re-packing the same tree is byte-identical (determinism guard).
		expect(await packDirToTar(sourceVault)).toEqual(archive);

		// ── 3. Untar to a fresh location (different path, with a space). ────
		await unpackTarToDir(archive, movedVault);

		// vault.json travelled intact (no absolute path baked into it).
		const movedVaultJson = JSON.parse(
			await readFile(join(movedVault, "vault.json"), "utf8"),
		) as Record<string, unknown>;
		expect(movedVaultJson.id).toBe(vaultId);
		expect(JSON.stringify(movedVaultJson)).not.toContain(sourceVault);

		// The portable keystore travelled inside the dir.
		const keystore = JSON.parse(
			await readFile(join(movedVault, "shell", "insecure-keystore.json"), "utf8"),
		) as { secrets: Record<string, string> };
		expect(keystore.secrets[`${vaultId}.identity`]).toBeDefined();
		expect(keystore.secrets[`${vaultId}.master`]).toBeDefined();

		// ── 4. Re-open at the new path; assert full recovery. ──────────────
		const { openVault, getActiveVaultSession, closeActiveVaultSession } = await loadVaultModule();
		const reopened = await openVault(movedVault, INSECURE);
		expect(reopened.id).toBe(vaultId);
		expect(reopened.path).toBe(movedVault);

		const session = getActiveVaultSession();
		if (!session) throw new Error("expected an active session after re-open");

		// Identity recovers — same public key + fingerprint.
		expect(session.identity.fingerprint).toBe(originalFingerprint);
		expect(session.identity.publicKeyBase64).toBe(originalPublicKey);

		// Master key unlocks — the sealed credential decrypts to plaintext.
		const token = await session.getCredential({ app: "test", key: "token" });
		expect(token).not.toBeNull();
		expect(new TextDecoder().decode(token ?? new Uint8Array())).toBe("super-secret-value");

		// entities.db byte-faithful — same row, same properties.
		const db = await session.dataStores.open("entities");
		const row = new EntitiesRepository(db).get(seededEntityId);
		expect(row).not.toBeNull();
		expect(row?.type).toBe("test/Note/v1");
		expect(row?.properties).toEqual({ title: "Portable note", count: 42, tags: ["a", "b"] });

		// Yjs doc survives — same doc state, CRC intact (no truncated tail).
		const loaded = await session.ydocStore.load(docEntityId);
		expect(loaded.truncatedTail).toBe(false);
		expect(loaded.doc.getText("body").toString()).toBe("hello portable world");
		expect(loaded.doc.getMap("meta").get("kind")).toBe("demo");

		closeActiveVaultSession();
	});

	it("the moved vault can sign with the recovered identity (private key recovered, not just public)", async () => {
		let vaultId = "";
		let originalSignature = "";
		const payload = new TextEncoder().encode("portability-signing-probe");

		{
			const { createVault, getActiveVaultSession, closeActiveVaultSession } = await loadVaultModule();
			const entry = await createVault({ name: "Signer", path: sourceVault, ...INSECURE });
			vaultId = entry.id;
			const session = getActiveVaultSession();
			if (!session) throw new Error("expected an active session");
			originalSignature = Buffer.from(session.signPayload(payload)).toString("base64");
			closeActiveVaultSession();
		}

		const archive = await packDirToTar(sourceVault);
		await unpackTarToDir(archive, movedVault);

		const { openVault, getActiveVaultSession, closeActiveVaultSession } = await loadVaultModule();
		await openVault(movedVault, INSECURE);
		const session = getActiveVaultSession();
		if (!session) throw new Error("expected an active session after re-open");
		expect(session.vaultId).toBe(vaultId);

		// Ed25519 is deterministic — the same secret signs the same payload to
		// the same bytes. A matching signature proves the PRIVATE key (not just
		// the recorded public key) round-tripped.
		const movedSignature = Buffer.from(session.signPayload(payload)).toString("base64");
		expect(movedSignature).toBe(originalSignature);
		closeActiveVaultSession();
	});

	it("normalises path separators on extract (a `/`-named archive lands on the host separator)", async () => {
		// Build a tiny tree with a nested sharded-id-style path, pack it, and
		// confirm the unpacker reconstructs the nested layout using the host
		// separator — the macOS-tar → Linux-untar (and vice-versa) guarantee.
		const tree = join(workDir, "tree");
		await unpackTarToDir(Buffer.alloc(0), tree); // mkdir
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tree, "data", "docs", "ent"), { recursive: true });
		await writeFile(join(tree, "data", "docs", "ent", "ent_x.ydoc"), "payload");

		const archive = await packDirToTar(tree);
		// Archive names use the POSIX separator regardless of host.
		expect(archive.toString("latin1")).toContain("data/docs/ent/ent_x.ydoc");

		const out = join(workDir, "tree-out");
		await unpackTarToDir(archive, out);
		const recovered = await readFile(join(out, "data", "docs", "ent", "ent_x.ydoc"), "utf8");
		expect(recovered).toBe("payload");
	});

	it("rejects a path-traversal entry on extract (defence-in-depth)", async () => {
		// Hand-craft a 512-byte ustar header naming `../escape` and assert the
		// unpacker refuses it rather than writing outside `dest`.
		const block = Buffer.alloc(512 * 3);
		block.write("../escape", 0, 100, "utf8");
		block.write("0000644\0", 100, 8, "ascii");
		block.write("00000000000\0", 124, 12, "ascii"); // size 0
		block.write("0", 156, 1, "ascii");
		block.write("ustar\0", 257, 6, "ascii");
		block.write("        ", 148, 8, "ascii");
		let sum = 0;
		for (let i = 0; i < 512; i++) sum += block[i] ?? 0;
		block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");

		const out = join(workDir, "traversal-out");
		await expect(unpackTarToDir(block, out)).rejects.toThrow(/path-traversal/);
	});
});

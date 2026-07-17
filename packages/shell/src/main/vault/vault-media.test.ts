import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultMediaDomain, isSealedMedia } from "../assets/vault-media-crypto";
import { removeTestDir } from "../test-support/remove-test-dir";
import { VaultSession } from "./session";

let vaultDir: string;
let session: VaultSession;

beforeEach(async () => {
	vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-vault-media-"));
	session = await VaultSession.create({
		vaultId: "vlt_media",
		vaultPath: vaultDir,
		forceInsecure: true,
	});
});
afterEach(async () => {
	// Await the full teardown so no handle inside `vaultDir` is still open
	// when the recursive rm runs (open handles → EBUSY on Windows).
	await session.dispose();
	await removeTestDir(vaultDir);
});

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe("VaultSession media at-rest (OQ-240)", () => {
	it("seals and opens a media blob round-trip under the real master key", () => {
		const sealed = session.sealMedia(VaultMediaDomain.Cover, "c.png", png);
		expect(isSealedMedia(sealed)).toBe(true);
		expect(Buffer.from(session.openMedia(VaultMediaDomain.Cover, "c.png", sealed))).toEqual(png);
	});

	it("migrateMediaAtRest seals legacy plaintext files across all domains", async () => {
		for (const domain of Object.values(VaultMediaDomain)) {
			const dir = join(vaultDir, domain);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "f.png"), png);
		}
		await session.migrateMediaAtRest();
		for (const domain of Object.values(VaultMediaDomain)) {
			const onDisk = await readFile(join(vaultDir, domain, "f.png"));
			expect(isSealedMedia(onDisk)).toBe(true);
			expect(Buffer.from(session.openMedia(domain, "f.png", onDisk))).toEqual(png);
		}
	});

	it("rejects media ops after dispose (key zeroed)", () => {
		session.dispose();
		expect(() => session.sealMedia(VaultMediaDomain.Icon, "x.png", png)).toThrow();
		// re-create for the afterEach dispose (idempotent dispose is fine).
		// (no-op: afterEach disposes again safely)
	});
});

/**
 * F-492 — what pairing actually does to the JOINING device's identity.
 *
 * Two claims, both checked against real `VaultSession`s rather than mocks,
 * because the second one decides whether the fix is a re-subscribe or a
 * design change:
 *
 *   1. `saveIdentitySecret` (what `scanPayload` calls) writes the SOURCE's
 *      identity secret into the target's keystore and does NOT change the
 *      live session — so the running session keeps its pre-pairing identity
 *      and every identity-derived channel (the `inbox:` route the 10.3c
 *      sibling wrap rides) stays on the old key.
 *
 *   2. The next `VaultSession.open` on that device then FAILS, because
 *      `vault.json` still records the target's original `identityPublicKey`
 *      (it is written once, at vault creation, and pairing never updates it)
 *      while the keystore now holds the source's secret.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultSession } from "../vault/session";

describe("F-492 — pairing's identity adoption on the joining device", () => {
	let sourceDir = "";
	let targetDir = "";
	let source: VaultSession | undefined;
	let target: VaultSession | undefined;

	beforeEach(async () => {
		sourceDir = await mkdtemp(join(tmpdir(), "bs-f492-src-"));
		targetDir = await mkdtemp(join(tmpdir(), "bs-f492-tgt-"));
		source = await VaultSession.create({
			vaultId: "vlt_source",
			vaultPath: sourceDir,
			forceInsecure: true,
		});
		target = await VaultSession.create({
			vaultId: "vlt_target",
			vaultPath: targetDir,
			forceInsecure: true,
		});
	});

	afterEach(async () => {
		await source?.dispose();
		await target?.dispose();
		await rm(sourceDir, { recursive: true, force: true });
		await rm(targetDir, { recursive: true, force: true });
	});

	it("leaves the LIVE session on its pre-pairing identity", async () => {
		if (!source || !target) throw new Error("expected both sessions");
		const before = target.identity.publicKeyBase64;
		expect(before).not.toBe(source.identity.publicKeyBase64);

		// Exactly what `pairing-handlers.ts` binds `saveIdentitySecret` to.
		await target.backend.setSecret(
			target.vaultId,
			"identity",
			source.exposeIdentityForPairing().secretKey,
		);

		// The running session is unchanged — this is why the joining device
		// keeps subscribing `inbox:<its OLD identity>` while the source fans
		// wraps out to `inbox:<the shared identity>`.
		expect(target.identity.publicKeyBase64).toBe(before);
		expect(target.identity.publicKeyBase64).not.toBe(source.identity.publicKeyBase64);
	});

	it("makes the NEXT vault open fail — vault.json still names the old identity", async () => {
		if (!source || !target) throw new Error("expected both sessions");
		const targetOriginalPub = target.identity.publicKeyBase64;
		await target.backend.setSecret(
			target.vaultId,
			"identity",
			source.exposeIdentityForPairing().secretKey,
		);
		await target.dispose();
		target = undefined;

		// `vault.json` records `identityPublicKey` at CREATION and pairing
		// never rewrites it, so the re-open carries the stale expectation.
		await expect(
			VaultSession.open("vlt_target", targetDir, {
				forceInsecure: true,
				expectedPublicKeyBase64: targetOriginalPub,
			}),
		).rejects.toThrow(/does not match vault\.json/);
	});
});

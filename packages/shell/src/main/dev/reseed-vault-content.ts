/**
 * Regenerate the BrainstormProject plan projection for a dev vault and apply
 * it in-process.
 *
 * The plan → Tasks/Calendar/Notes/Graph projection is NOT a static one-shot:
 * every pending task's due date is anchored to a 30-day window starting at the
 * seed's `now`, and every iteration's done-ness comes from the plan markdown
 * (✅/🟡/⚪) + log. Two things therefore go stale the moment the seed is older
 * than the vault: pending tasks drift past "today" (they were laid into a fixed
 * window, wall-clock moves on), and iterations marked done in the plan never
 * reach the vault. Re-running the projection with a fresh `now` re-anchors the
 * dates and picks up the status edits.
 *
 * The Bun seed-cli writes the fresh-dated snapshot to the seed sidecar — it
 * can't open the encrypted `entities.db` (no SQLCipher under Bun). This drains
 * that sidecar through the session's already-decrypted repo (master key +
 * SQLCipher live in this process).
 *
 * **Fresh vaults stay empty.** Auto-reseed only runs when the vault already
 * carries BrainstormProject seed content (or a pending sidecar from a manual
 * `seed-cli` run). Otherwise a new vault created with "Add starter content"
 * unchecked still got flooded with the full implementation-plan projection
 * on every `bun run dev` boot.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import {
	SEED_PROVENANCE_KEY,
	SEED_PROVENANCE_VALUE,
	readSeedSidecar,
} from "../entities/seed-snapshot";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import type { VaultSession } from "../vault/session";
import { type DrainResult, drainSeedSidecar } from "./drain-seed-sidecar";

export type ReseedContentResult =
	| { ok: true; drained: DrainResult; skipped?: "no-prior-seed" }
	| { ok: false; reason: string };

/** Types the plan seeder is the *only* creator of — presence of any row of
 *  these types means this vault has already been project-seeded. */
const PROJECT_SEED_PROBE_TYPES = [
	"brainstorm/Iteration/v1",
	"brainstorm/Stage/v1",
	"brainstorm/OpenQuestion/v1",
	"brainstorm/DesignDoc/v1",
] as const;

/** True when the vault already carries BrainstormProject content (or a
 *  pending sidecar a manual seed-cli left for us). Fresh / user vaults are
 *  false so auto-reseed never plants the plan projection into them. */
export async function vaultHasProjectSeed(session: VaultSession): Promise<boolean> {
	const pending = await readSeedSidecar(session.vaultPath);
	if (pending) return true;
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	// Provenance marker the seeder stamps on every projected entity.
	if (repo.listIdsWithProperty(SEED_PROVENANCE_KEY, SEED_PROVENANCE_VALUE).length > 0) {
		return true;
	}
	// Cheap type probe for exclusively-seeded types (Iteration/Stage/…). A
	// vault that only has free-form notes from a one-off import is NOT a
	// project-seed vault — don't re-plant the plan projection into it.
	for (const type of PROJECT_SEED_PROBE_TYPES) {
		if (repo.query({ type: [type], limit: 1 }).length > 0) return true;
	}
	return false;
}

/** Spawn the Bun seed-cli (fresh `now`) against `vaultPath`, then drain the
 *  sidecar it parks. `repoRoot` resolves both the seed-cli path and the
 *  spawn cwd. Skips when the vault has never been project-seeded. */
export async function reseedVaultContent(
	repoRoot: string,
	session: VaultSession,
): Promise<ReseedContentResult> {
	if (!(await vaultHasProjectSeed(session))) {
		return {
			ok: true,
			drained: {
				applied: false,
				entitiesCreated: 0,
				entitiesUpdated: 0,
				linksWritten: 0,
				entitiesRemoved: 0,
			},
			skipped: "no-prior-seed",
		};
	}
	const seedCli = join(repoRoot, "tools", "mcp-server", "src", "seed", "seed-cli.ts");
	const spawned = await spawnSeedCli(seedCli, session.vaultPath, repoRoot);
	if (!spawned.ok) return spawned;
	const drained = await drainSeedSidecar(session);
	return { ok: true, drained };
}

function spawnSeedCli(
	seedCliPath: string,
	vaultPath: string,
	cwd: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	return new Promise((resolve) => {
		// `--defer-sidecar`: this shell holds entities.db open, so the CLI must NOT
		// open a second writer connection (cross-process WAL contention → "database
		// is locked", F-278). It parks the projection in the seed sidecar, which
		// the caller drains in-process on this shell's single connection.
		const child = spawn("bun", ["run", seedCliPath, "--vault", vaultPath, "--defer-sidecar"], {
			cwd,
			stdio: "pipe",
		});
		let stderr = "";
		let stdout = "";
		// Drain BOTH pipes (seed-cli logs a per-app summary on stdout). An
		// unread pipe blocks the child's write at ~64 KB; vite/seed output
		// fills that easily — the child hangs and the await never resolves.
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			resolve({ ok: false, reason: `spawn failed: ${error.message}` });
		});
		child.on("exit", (code) => {
			if (stdout.length > 0) {
				for (const line of stdout.split("\n")) {
					if (line.length > 0) console.log(`[dev:reseed-vault] ${line}`);
				}
			}
			if (code === 0) resolve({ ok: true });
			else resolve({ ok: false, reason: `seed-cli exited ${code}: ${stderr.slice(-400)}` });
		});
	});
}

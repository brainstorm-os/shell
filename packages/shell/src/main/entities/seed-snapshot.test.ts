import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open as openSqlite } from "@brainstorm-os/sqlite";
import type { SqliteDatabase } from "@brainstorm-os/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import { ENTITIES_MIGRATIONS } from "../storage/entities-schema";
import { applyMigrations } from "../storage/migrations";
import {
	SEED_PROVENANCE_KEY,
	SEED_PROVENANCE_VALUE,
	applySeederSnapshot,
	clearSeedSidecar,
	readSeedSidecar,
	writeSeedSidecar,
} from "./seed-snapshot";
import type { VaultEntitiesSnapshot } from "./vault-entities-service";

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

afterEach(() => {
	for (const db of dbs.splice(0)) {
		// `tunePragmas` opens these in WAL mode; on Windows the `-shm` shared-
		// memory mapping lingers past `close()` and locks the dir (POSIX releases
		// it immediately — this only bit the Windows CI runner). Checkpoint +
		// switch journal_mode off WAL so the `-wal`/`-shm` files (and their
		// mapping) are gone before close, leaving the dir free to remove.
		try {
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			db.exec("PRAGMA journal_mode = DELETE");
		} catch {
			// Best-effort — a half-open db still gets closed + the dir retried.
		}
		db.close();
	}
	for (const d of dirs.splice(0)) {
		// Best-effort: if Windows STILL holds the WAL `-shm` mapping past the
		// checkpoint + retries above, a leaked test temp dir (the OS reaps `Temp`)
		// is not a test failure — the seeding assertions have already run. Don't
		// let teardown throw and turn green logic red on the Windows runner.
		try {
			rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch {
			// swallow EBUSY/EPERM lock-lag; the OS cleans the temp dir later.
		}
	}
});

async function freshRepo(): Promise<EntitiesRepository> {
	const dir = mkdtempSync(join(tmpdir(), "bs-seed-snap-"));
	dirs.push(dir);
	const db = await openSqlite(join(dir, "entities.db"), { tunePragmas: true });
	dbs.push(db);
	await applyMigrations(db, ENTITIES_MIGRATIONS);
	return new EntitiesRepository(db);
}

function snapshot(): VaultEntitiesSnapshot {
	return {
		entities: [
			{
				id: "journal-2026-06-01",
				type: "io.brainstorm.journal/Entry/v1",
				properties: { name: "2026-06-01", title: "2026-06-01" },
				createdAt: 1000,
				updatedAt: 1000,
				deletedAt: null,
				ownerAppId: "io.brainstorm.journal",
			},
			{
				id: "note:welcome",
				type: "io.brainstorm.notes/Note/v1",
				properties: { name: "Welcome", title: "Welcome" },
				createdAt: 1000,
				updatedAt: 1000,
				deletedAt: null,
				ownerAppId: "io.brainstorm.notes",
			},
		],
		links: [
			{
				id: "lnk-1",
				sourceEntityId: "journal-2026-06-01",
				destEntityId: "note:welcome",
				linkType: "mention",
				createdAt: 1000,
				deletedAt: null,
			},
		],
	};
}

describe("applySeederSnapshot", () => {
	it("creates entities + links on first apply", async () => {
		const repo = await freshRepo();
		const stats = applySeederSnapshot(repo, snapshot(), 2000);
		expect(stats).toEqual({
			entitiesCreated: 2,
			entitiesUpdated: 0,
			linksWritten: 1,
			entitiesRemoved: 0,
		});
		expect(repo.get("journal-2026-06-01")?.type).toBe("io.brainstorm.journal/Entry/v1");
		expect(repo.linksFrom("journal-2026-06-01")).toHaveLength(1);
	});

	it("updates in place on re-apply rather than duplicating", async () => {
		const repo = await freshRepo();
		applySeederSnapshot(repo, snapshot(), 2000);
		const second = applySeederSnapshot(repo, snapshot(), 3000);
		expect(second).toEqual({
			entitiesCreated: 0,
			entitiesUpdated: 2,
			linksWritten: 1,
			entitiesRemoved: 0,
		});
	});

	it("restores a soft-deleted (binned) id instead of colliding on the primary key", async () => {
		const repo = await freshRepo();
		applySeederSnapshot(repo, snapshot(), 2000);
		// User bins a seeded entity — the row physically remains, deleted_at set,
		// so a naive create would hit SQLITE_CONSTRAINT_PRIMARYKEY on re-seed.
		expect(repo.softDelete("journal-2026-06-01", 2500)).toBe(true);
		expect(repo.get("journal-2026-06-01")).toBeNull();

		const second = applySeederSnapshot(repo, snapshot(), 3000);
		expect(second).toEqual({
			entitiesCreated: 0,
			entitiesUpdated: 2,
			linksWritten: 1,
			entitiesRemoved: 0,
		});
		// Restored and live again.
		expect(repo.get("journal-2026-06-01")?.type).toBe("io.brainstorm.journal/Entry/v1");
	});

	it("stamps the seed-provenance marker on every seeded entity", async () => {
		const repo = await freshRepo();
		applySeederSnapshot(repo, snapshot(), 2000);
		expect(repo.get("note:welcome")?.properties[SEED_PROVENANCE_KEY]).toBe(SEED_PROVENANCE_VALUE);
		expect(repo.get("journal-2026-06-01")?.properties[SEED_PROVENANCE_KEY]).toBe(
			SEED_PROVENANCE_VALUE,
		);
	});

	it("reconciles: a seeded id dropped from a later snapshot is removed", async () => {
		const repo = await freshRepo();
		applySeederSnapshot(repo, snapshot(), 2000);

		// Simulate a plan edit: the journal entry is renamed/renumbered, so the
		// new snapshot no longer carries `journal-2026-06-01`. Without reconcile
		// it would linger forever (the overdue-ghost bug).
		const next = snapshot();
		next.entities = next.entities.filter((e) => e.id !== "journal-2026-06-01");
		next.links = [];

		const stats = applySeederSnapshot(repo, next, 3000);
		expect(stats.entitiesRemoved).toBe(1);
		expect(repo.get("journal-2026-06-01")).toBeNull();
		expect(repo.get("note:welcome")?.type).toBe("io.brainstorm.notes/Note/v1");
	});

	it("never removes a hand-created (unmarked) entity absent from the snapshot", async () => {
		const repo = await freshRepo();
		applySeederSnapshot(repo, snapshot(), 2000);
		// An entity the user made by hand in the app — no seed marker.
		repo.create({
			id: "user-note-1",
			type: "io.brainstorm.notes/Note/v1",
			properties: { name: "My note" },
			createdBy: "io.brainstorm.notes",
			now: 2100,
			dekId: "dek-1",
		});

		// Reseed with a snapshot that doesn't mention the hand-made note.
		const stats = applySeederSnapshot(repo, snapshot(), 3000);
		expect(stats.entitiesRemoved).toBe(0);
		expect(repo.get("user-note-1")?.properties.name).toBe("My note");
	});

	it("sweeps pre-marker legacy orphans (plan ids) but spares Welcome/hand-made/shell entities", async () => {
		const repo = await freshRepo();
		// Simulate a vault seeded BEFORE the provenance marker existed: these
		// rows carry no `__seededBy`. Created with dek_id null like the old seeder.
		const legacy = (id: string, type: string) =>
			repo.create({ id, type, properties: { name: id }, createdBy: "x", now: 1, dekId: null });
		legacy("task-iter-9-14-old", "brainstorm/Task/v1"); // renamed-away plan task → orphan
		legacy("proj-app-graveyard", "brainstorm/Project/v1"); // dropped plan project → orphan
		legacy("sec-domain-shell-gone", "brainstorm/Section/v1"); // dropped section → orphan
		legacy("iter-removed-iteration", "brainstorm/Iteration/v1"); // exclusively-seeded type → orphan
		legacy("oq-retired", "brainstorm/OpenQuestion/v1"); // exclusively-seeded type → orphan
		// Must SURVIVE: Welcome starter content (own id namespace, dek null, same types)…
		legacy("welcome-task-tour", "brainstorm/Task/v1");
		legacy("welcome-project-getting-started", "brainstorm/Project/v1");
		// …a hand-made task (uuid id namespace)…
		repo.create({
			id: "task-3f8a2b1c-uuid",
			type: "brainstorm/Task/v1",
			properties: { name: "mine" },
			createdBy: "io.brainstorm.tasks",
			now: 1,
			dekId: "dek-9",
		});
		// …and the shell root folder (exclusively-seeded? no — Folder isn't in the
		// sweep set at all, and its id is its own namespace).
		legacy("brainstorm/root-folder/v1", "brainstorm/Folder/v1");

		// A reseed whose snapshot contains NONE of the above ids.
		const stats = applySeederSnapshot(repo, snapshot(), 3000);

		expect(stats.entitiesRemoved).toBe(5);
		for (const gone of [
			"task-iter-9-14-old",
			"proj-app-graveyard",
			"sec-domain-shell-gone",
			"iter-removed-iteration",
			"oq-retired",
		]) {
			expect(repo.get(gone)).toBeNull();
		}
		for (const kept of [
			"welcome-task-tour",
			"welcome-project-getting-started",
			"task-3f8a2b1c-uuid",
			"brainstorm/root-folder/v1",
		]) {
			expect(repo.get(kept)).not.toBeNull();
		}
	});

	it("heals the SH-37 Task/Iteration id collision: stale Task `iter-X` becomes the snapshot Iteration, no duplicate Task lingers", async () => {
		const repo = await freshRepo();
		// Pre-SH-37 vault: the Task lived at the SAME id as its source iteration
		// (`iter-<code>`) and carries a stale, long-overdue date. Unmarked.
		repo.create({
			id: "iter-9-9-1",
			type: "brainstorm/Task/v1",
			properties: { name: "9.9.1 — scaffold", statusKey: "pending", dueAt: 1000, scheduledAt: 1000 },
			createdBy: "io.brainstorm.tasks",
			now: 1,
			dekId: null,
		});
		// A pre-SH-37 Task with no matching snapshot entity of any type — the true
		// orphan the collision-heal can't see (its id isn't in the snapshot at all).
		repo.create({
			id: "iter-removed-9-9-9",
			type: "brainstorm/Task/v1",
			properties: { name: "9.9.9 — dropped", statusKey: "pending", dueAt: 1000 },
			createdBy: "io.brainstorm.tasks",
			now: 1,
			dekId: null,
		});

		// Post-SH-37 snapshot: the Iteration owns `iter-9-9-1`; the Task moved to
		// `task-iter-9-9-1` with a fresh future date.
		const next: VaultEntitiesSnapshot = {
			entities: [
				{
					id: "iter-9-9-1",
					type: "brainstorm/Iteration/v1",
					properties: { name: "9.9.1 — scaffold", code: "9.9.1" },
					createdAt: 3000,
					updatedAt: 3000,
					deletedAt: null,
					ownerAppId: "io.brainstorm.shell",
				},
				{
					id: "task-iter-9-9-1",
					type: "brainstorm/Task/v1",
					properties: {
						name: "9.9.1 — scaffold",
						statusKey: "pending",
						dueAt: 9_000_000,
						scheduledAt: 9_000_000,
						iterationId: "iter-9-9-1",
					},
					createdAt: 3000,
					updatedAt: 3000,
					deletedAt: null,
					ownerAppId: "io.brainstorm.tasks",
				},
			],
			links: [],
		};

		applySeederSnapshot(repo, next, 3000);

		// `iter-9-9-1` is now the Iteration, not a stale Task.
		expect(repo.get("iter-9-9-1")?.type).toBe("brainstorm/Iteration/v1");
		// The fresh Task exists with the re-anchored date.
		expect(repo.get("task-iter-9-9-1")?.type).toBe("brainstorm/Task/v1");
		expect(repo.get("task-iter-9-9-1")?.properties.dueAt).toBe(9_000_000);
		// No Task/v1 duplicate lingers under either old id.
		const tasks = repo.query({ type: "brainstorm/Task/v1" });
		expect(tasks.map((t) => t.id).sort()).toEqual(["task-iter-9-9-1"]);
		expect(repo.get("iter-removed-9-9-9")).toBeNull();
	});
});

describe("seed sidecar round-trip", () => {
	it("reads the snapshot without consuming it; clear removes the file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bs-seed-sidecar-"));
		dirs.push(dir);
		await writeSeedSidecar(dir, snapshot());

		// Read is non-destructive — a failed apply must be able to retry.
		const first = await readSeedSidecar(dir);
		expect(first?.entities).toHaveLength(2);
		expect(first?.links).toHaveLength(1);
		expect((await readSeedSidecar(dir))?.entities).toHaveLength(2);

		await clearSeedSidecar(dir);
		expect(await readSeedSidecar(dir)).toBeNull();
	});

	it("returns null when no sidecar exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bs-seed-sidecar-"));
		dirs.push(dir);
		expect(await readSeedSidecar(dir)).toBeNull();
	});

	it("clear is a no-op when no sidecar exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bs-seed-sidecar-"));
		dirs.push(dir);
		await expect(clearSeedSidecar(dir)).resolves.toBeUndefined();
	});
});

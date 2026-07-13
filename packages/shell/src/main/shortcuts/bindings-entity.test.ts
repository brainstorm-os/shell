/**
 * 6.7 — the flat `shortcut-bindings.json` → `brainstorm/ShortcutBindings/v1`
 * entity migration. Reproduce-before-patch: a pre-existing flat-file vault
 * is migrated into the entity on vault open and the registry reads it back
 * unchanged; idempotent across two boots; never clobbers a newer entity
 * row; the flat file is left intact; a fresh vault (no file / no entity) =
 * defaults, no-op.
 */

import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import {
	SHORTCUT_BINDINGS_ENTITY_ID,
	SHORTCUT_BINDINGS_TYPE,
	ShortcutBindingsScopeKind,
	migrateBindingsFileToEntity,
	overridesFromEntityProperties,
	readOverridesFromEntity,
	writeOverridesToEntity,
} from "./bindings-entity";
import { bindingsPath, readBindings, writeBindings } from "./bindings-store";
import { ShortcutRegistry } from "./shortcut-registry";

describe("shortcut-bindings flat-file → entity migration (6.7)", () => {
	let vaultPath: string;
	let stores: DataStores;
	let repo: EntitiesRepository;

	beforeEach(async () => {
		vaultPath = await mkdtemp(join(tmpdir(), "bs-sbindings-"));
		stores = new DataStores(vaultPath);
		repo = new EntitiesRepository(await stores.open("entities"));
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultPath, { recursive: true, force: true });
	});

	const OVERRIDES = [
		{ id: "shell/launcher", chord: "CmdOrCtrl+P" },
		{ id: "io.example.editor/format-bold", chord: null },
	];

	it("(e) fresh vault: no file, no entity → no-op, defaults apply", async () => {
		const r = await migrateBindingsFileToEntity(vaultPath, repo);
		expect(r).toEqual({ migrated: false, reason: "no-overrides" });
		expect(repo.get(SHORTCUT_BINDINGS_ENTITY_ID)).toBeNull();

		const registry = new ShortcutRegistry();
		registry.registerShell();
		registry.applyOverrides(readOverridesFromEntity(repo));
		// Launcher keeps its shipped default — no override applied.
		expect(registry.resolve("shell/launcher")?.chord).toBe("CmdOrCtrl+K");
		expect(registry.resolve("shell/launcher")?.source).toBe("default");
	});

	it("(a) a pre-existing flat-file vault is migrated and the registry reads it back unchanged", async () => {
		await writeBindings(vaultPath, OVERRIDES);

		const r = await migrateBindingsFileToEntity(vaultPath, repo);
		expect(r).toEqual({ migrated: true });

		const row = repo.get(SHORTCUT_BINDINGS_ENTITY_ID);
		expect(row).not.toBeNull();
		expect(row?.type).toBe(SHORTCUT_BINDINGS_TYPE);
		// No shape change: the file body is carried through byte-for-byte.
		expect(row?.properties).toEqual({
			version: 1,
			overrides: OVERRIDES,
			scope: { kind: ShortcutBindingsScopeKind.User },
		});

		const registry = new ShortcutRegistry();
		registry.registerShell();
		registry.applyOverrides(readOverridesFromEntity(repo));
		expect(registry.resolve("shell/launcher")).toEqual({
			action: expect.objectContaining({ id: "shell/launcher" }),
			chord: "CmdOrCtrl+P",
			source: "user-override",
		});
	});

	it("data shape is unchanged: entity overrides === flat-file overrides", async () => {
		await writeBindings(vaultPath, OVERRIDES);
		await migrateBindingsFileToEntity(vaultPath, repo);

		const fromFile = (await readBindings(vaultPath)).overrides;
		const fromEntity = readOverridesFromEntity(repo);
		expect(fromEntity).toEqual(fromFile);
	});

	it("(b) idempotent across two boots — second run is a no-op, no duplicate / no clobber", async () => {
		await writeBindings(vaultPath, OVERRIDES);

		const first = await migrateBindingsFileToEntity(vaultPath, repo);
		expect(first.migrated).toBe(true);
		const afterFirst = repo.get(SHORTCUT_BINDINGS_ENTITY_ID);

		const second = await migrateBindingsFileToEntity(vaultPath, repo);
		expect(second).toEqual({ migrated: false, reason: "already-present" });

		// Exactly one row of this type; unchanged across the second run.
		expect(repo.query({ type: SHORTCUT_BINDINGS_TYPE })).toHaveLength(1);
		expect(repo.get(SHORTCUT_BINDINGS_ENTITY_ID)).toEqual(afterFirst);
	});

	it("(c) never clobbers a newer entity row written through the registry after the first migration", async () => {
		await writeBindings(vaultPath, OVERRIDES);
		await migrateBindingsFileToEntity(vaultPath, repo);

		// User rebinds through the (future) settings path → entity is now
		// newer than the file.
		const newer = [{ id: "shell/launcher", chord: "CmdOrCtrl+J" }];
		writeOverridesToEntity(repo, newer);

		// Next boot re-runs the migration — it must NOT overwrite the newer
		// entity with the stale file body.
		const r = await migrateBindingsFileToEntity(vaultPath, repo);
		expect(r).toEqual({ migrated: false, reason: "already-present" });
		expect(readOverridesFromEntity(repo)).toEqual(newer);
	});

	it("(d) the flat file is left intact (non-destructive bridge / older-shell fallback)", async () => {
		await writeBindings(vaultPath, OVERRIDES);
		const before = await readFile(bindingsPath(vaultPath), "utf8");

		await migrateBindingsFileToEntity(vaultPath, repo);

		const after = await readFile(bindingsPath(vaultPath), "utf8");
		expect(after).toBe(before);
		expect((await readBindings(vaultPath)).overrides).toEqual(OVERRIDES);
	});

	it("a file that exists but carries zero overrides does not create an empty row (lazy creation)", async () => {
		await writeBindings(vaultPath, []);
		const r = await migrateBindingsFileToEntity(vaultPath, repo);
		expect(r).toEqual({ migrated: false, reason: "no-overrides" });
		expect(repo.get(SHORTCUT_BINDINGS_ENTITY_ID)).toBeNull();
	});

	it("write path creates the singleton lazily then updates it in place", async () => {
		expect(repo.get(SHORTCUT_BINDINGS_ENTITY_ID)).toBeNull();

		writeOverridesToEntity(repo, [{ id: "shell/new", chord: "CmdOrCtrl+T" }]);
		expect(readOverridesFromEntity(repo)).toEqual([{ id: "shell/new", chord: "CmdOrCtrl+T" }]);

		writeOverridesToEntity(repo, [{ id: "shell/new", chord: null }]);
		expect(readOverridesFromEntity(repo)).toEqual([{ id: "shell/new", chord: null }]);
		// Still a single row — update in place, not a second create.
		expect(repo.query({ type: SHORTCUT_BINDINGS_TYPE })).toHaveLength(1);
	});

	it("overridesFromEntityProperties tolerates a missing / malformed blob", () => {
		expect(overridesFromEntityProperties(null)).toEqual([]);
		expect(overridesFromEntityProperties({})).toEqual([]);
		expect(overridesFromEntityProperties({ overrides: "nope" })).toEqual([]);
		expect(
			overridesFromEntityProperties({
				overrides: [
					{ id: "ok", chord: "X" },
					{ id: "", chord: "bad-empty-id" },
					{ id: "numeric", chord: 42 },
					{ id: "cleared", chord: null },
				],
			}),
		).toEqual([
			{ id: "ok", chord: "X" },
			{ id: "cleared", chord: null },
		]);
	});
});

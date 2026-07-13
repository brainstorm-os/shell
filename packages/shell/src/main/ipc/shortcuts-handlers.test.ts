/**
 * shortcuts-handlers — privileged ipcMain wiring for Settings → Keyboard
 * rebinding. Electron is mocked; the handlers are driven through a real
 * `ShortcutRegistry` + a real `EntitiesRepository` (so persistence
 * round-trips through the actual schema, not a stub).
 *
 * Asserts: channel registration, list payload contract, set/reset
 * round-trip into the registry, persist into the entity row, broadcast
 * fires exactly when state changes, conflict + bare-modifier + unknown-id
 * + empty-chord rejection paths, and that an entity-write failure
 * doesn't roll back the in-memory override (fail-soft per the doc-24
 * "session honours the user's intent" rule).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: IpcHandler) => {
			handlers.set(channel, fn);
		},
	},
}));

import {
	SHORTCUT_BINDINGS_ENTITY_ID,
	overridesFromEntityProperties,
} from "../shortcuts/bindings-entity";
import { DEFAULT_SHELL_SHORTCUTS, ShortcutRegistry } from "../shortcuts/shortcut-registry";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository } from "../storage/entities-repo";
import {
	SHORTCUTS_BINDINGS_CHANGED_CHANNEL,
	SHORTCUTS_LIST_CHANNEL,
	SHORTCUTS_RESET_OVERRIDE_CHANNEL,
	SHORTCUTS_SET_OVERRIDE_CHANNEL,
	SetOverrideErrorReason,
	type ShortcutBindingRow,
	registerShortcutsHandlers,
} from "./shortcuts-handlers";

const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
	Promise.resolve(handlers.get(channel)?.({}, ...args) as T);

type FakeWebContents = {
	isDestroyed: () => boolean;
	send: ReturnType<typeof vi.fn>;
};

let vaultDir: string;
let stores: DataStores;
let repo: EntitiesRepository;
let registry: ShortcutRegistry;
let dashboard: FakeWebContents;

beforeEach(async () => {
	handlers.clear();
	vaultDir = await mkdtemp(join(tmpdir(), "bs-shortcuts-ipc-"));
	stores = new DataStores(vaultDir);
	repo = new EntitiesRepository(await stores.open("entities"));
	registry = new ShortcutRegistry();
	registry.registerShell(DEFAULT_SHELL_SHORTCUTS);
	dashboard = { isDestroyed: () => false, send: vi.fn() };
	registerShortcutsHandlers({
		getRegistry: () => registry,
		getRepo: async () => repo,
		getDashboard: () => dashboard as unknown as Electron.WebContents,
	});
});

afterEach(async () => {
	stores.close();
	await rm(vaultDir, { recursive: true, force: true });
});

describe("shortcuts-handlers — channel registration", () => {
	it("registers exactly the three list/set/reset channels", () => {
		expect([...handlers.keys()].sort()).toEqual(
			[
				SHORTCUTS_LIST_CHANNEL,
				SHORTCUTS_RESET_OVERRIDE_CHANNEL,
				SHORTCUTS_SET_OVERRIDE_CHANNEL,
			].sort(),
		);
	});
});

describe("shortcuts-handlers — list", () => {
	it("returns every shell binding with the wire contract", async () => {
		const rows = await invoke<ShortcutBindingRow[]>(SHORTCUTS_LIST_CHANNEL);
		const launcher = rows.find((r) => r.id === "shell/launcher");
		expect(launcher).toBeDefined();
		expect(launcher).toMatchObject({
			id: "shell/launcher",
			layer: "shell",
			label: "Open Launcher",
			chord: "CmdOrCtrl+K",
			defaultChord: "CmdOrCtrl+K",
			source: "default",
		});
	});

	it("returns an empty list when no registry is wired", async () => {
		handlers.clear();
		registerShortcutsHandlers({
			getRegistry: () => null,
			getRepo: async () => repo,
			getDashboard: () => dashboard as unknown as Electron.WebContents,
		});
		expect(await invoke<ShortcutBindingRow[]>(SHORTCUTS_LIST_CHANNEL)).toEqual([]);
	});

	it("reflects user overrides in chord + source", async () => {
		await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "Mod+J");
		const rows = await invoke<ShortcutBindingRow[]>(SHORTCUTS_LIST_CHANNEL);
		const launcher = rows.find((r) => r.id === "shell/launcher");
		expect(launcher).toMatchObject({
			id: "shell/launcher",
			chord: "Mod+J",
			defaultChord: "CmdOrCtrl+K",
			source: "user-override",
		});
	});
});

describe("shortcuts-handlers — set override happy path", () => {
	it("writes the override into the registry + persists into entities.db + broadcasts", async () => {
		const result = await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "Mod+J");
		expect(result).toEqual({ ok: true });
		expect(registry.resolve("shell/launcher")?.chord).toBe("Mod+J");

		const row = repo.get(SHORTCUT_BINDINGS_ENTITY_ID);
		expect(row).not.toBeNull();
		const overrides = overridesFromEntityProperties(row?.properties);
		expect(overrides).toEqual([{ id: "shell/launcher", chord: "Mod+J" }]);

		expect(dashboard.send).toHaveBeenCalledWith(SHORTCUTS_BINDINGS_CHANGED_CHANNEL);
	});

	it("a null chord clears the binding (action remains accessible via menus)", async () => {
		const result = await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", null);
		expect(result).toEqual({ ok: true });
		const resolved = registry.resolve("shell/launcher");
		expect(resolved?.chord).toBeNull();
		expect(resolved?.source).toBe("cleared");
	});

	it("a Mod-tokenized override sits in the same normalize equivalence class as CmdOrCtrl", async () => {
		// Bind shell/launcher to `Mod+J` (no shell-side default chord uses it).
		await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "Mod+J");
		// `findByChord` consults `normalizeChord`, which collapses `Mod` →
		// `cmdorctrl` per chord.ts (the doc-canonical cross-platform alias).
		// So a lookup written as `CmdOrCtrl+J` lands on the same row.
		const canonical = registry.findByChord("CmdOrCtrl+J");
		expect(canonical.map((b) => b.action.id)).toEqual(["shell/launcher"]);
		// And the persisted chord stays `Mod`-tokenized — the wire format is
		// platform-portable, while the matcher reads via normalize.
		const resolved = registry.resolve("shell/launcher");
		expect(resolved?.chord).toBe("Mod+J");
	});
});

describe("shortcuts-handlers — set override rejection paths", () => {
	it("rejects unknown id", async () => {
		const result = await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "no/such-id", "Mod+J");
		expect(result).toEqual({ ok: false, reason: SetOverrideErrorReason.UnknownId });
		expect(dashboard.send).not.toHaveBeenCalled();
	});

	it("rejects empty / whitespace chord", async () => {
		expect(await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "")).toEqual({
			ok: false,
			reason: SetOverrideErrorReason.EmptyChord,
		});
		expect(await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "   ")).toEqual({
			ok: false,
			reason: SetOverrideErrorReason.EmptyChord,
		});
		expect(dashboard.send).not.toHaveBeenCalled();
	});

	it("rejects a bare-modifier chord (Shift alone, Mod alone)", async () => {
		expect(await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "Shift")).toEqual({
			ok: false,
			reason: SetOverrideErrorReason.BareModifier,
		});
		expect(await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "Mod+Shift")).toEqual({
			ok: false,
			reason: SetOverrideErrorReason.BareModifier,
		});
		expect(dashboard.send).not.toHaveBeenCalled();
	});

	it("rejects a conflicting chord (same normalized form as a different binding)", async () => {
		// Mod+Shift+B normalizes to the same chord as shell/bin's CmdOrCtrl+Shift+B.
		expect(await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "Mod+Shift+B")).toEqual({
			ok: false,
			reason: SetOverrideErrorReason.Conflict,
		});
		expect(dashboard.send).not.toHaveBeenCalled();
	});

	it("rebinding an action to its own current chord is a no-op success (self isn't a conflict)", async () => {
		expect(await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "CmdOrCtrl+K")).toEqual(
			{ ok: true },
		);
	});

	it("rejects a non-string non-null chord (malformed call)", async () => {
		expect(await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", 42)).toEqual({
			ok: false,
			reason: SetOverrideErrorReason.EmptyChord,
		});
	});
});

describe("shortcuts-handlers — reset override", () => {
	it("clears an override + persists snapshotted overrides + broadcasts", async () => {
		await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "Mod+J");
		dashboard.send.mockClear();

		const result = await invoke(SHORTCUTS_RESET_OVERRIDE_CHANNEL, "shell/launcher");
		expect(result).toEqual({ ok: true });
		expect(registry.resolve("shell/launcher")?.chord).toBe("CmdOrCtrl+K");
		expect(registry.resolve("shell/launcher")?.source).toBe("default");

		// The persisted overrides list no longer contains the cleared entry.
		const row = repo.get(SHORTCUT_BINDINGS_ENTITY_ID);
		expect(row).not.toBeNull();
		const overrides = overridesFromEntityProperties(row?.properties);
		expect(overrides).toEqual([]);

		expect(dashboard.send).toHaveBeenCalledWith(SHORTCUTS_BINDINGS_CHANGED_CHANNEL);
	});

	it("rejects unknown id", async () => {
		expect(await invoke(SHORTCUTS_RESET_OVERRIDE_CHANNEL, "no/such-id")).toEqual({
			ok: false,
			reason: "unknown-id",
		});
		expect(dashboard.send).not.toHaveBeenCalled();
	});
});

describe("shortcuts-handlers — broadcast fan-out", () => {
	it("skips broadcast when dashboard is destroyed", async () => {
		dashboard.isDestroyed = () => true;
		await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "Mod+J");
		expect(dashboard.send).not.toHaveBeenCalled();
	});

	it("skips broadcast when no dashboard is wired", async () => {
		handlers.clear();
		registerShortcutsHandlers({
			getRegistry: () => registry,
			getRepo: async () => repo,
			getDashboard: () => null,
		});
		const result = await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "Mod+J");
		expect(result).toEqual({ ok: true });
		// No dashboard → no listener, no crash.
	});
});

describe("shortcuts-handlers — fail-soft persistence", () => {
	it("when entity-write throws, the in-memory override still lands + the registry honours it", async () => {
		// Repo replaced with one whose `update`/`create` throws — simulates
		// an entities.db transient error. Per doc-24 the user's intent
		// should be honoured for the session.
		handlers.clear();
		const breakingRepo = {
			get: () => null,
			create: () => {
				throw new Error("entities.db is locked");
			},
			update: () => {
				throw new Error("entities.db is locked");
			},
		} as unknown as EntitiesRepository;
		registerShortcutsHandlers({
			getRegistry: () => registry,
			getRepo: async () => breakingRepo,
			getDashboard: () => dashboard as unknown as Electron.WebContents,
		});

		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "Mod+J");
		expect(result).toEqual({ ok: true });
		expect(registry.resolve("shell/launcher")?.chord).toBe("Mod+J");
		// Broadcast STILL fires — the renderer should repaint to reflect
		// the in-memory state, otherwise it's out of sync with the registry.
		expect(dashboard.send).toHaveBeenCalledWith(SHORTCUTS_BINDINGS_CHANGED_CHANNEL);

		consoleError.mockRestore();
	});

	it("when no vault is open (repo null), the override still lands in-memory + broadcasts", async () => {
		handlers.clear();
		registerShortcutsHandlers({
			getRegistry: () => registry,
			getRepo: async () => null,
			getDashboard: () => dashboard as unknown as Electron.WebContents,
		});

		const result = await invoke(SHORTCUTS_SET_OVERRIDE_CHANNEL, "shell/launcher", "Mod+J");
		expect(result).toEqual({ ok: true });
		expect(registry.resolve("shell/launcher")?.chord).toBe("Mod+J");
		expect(dashboard.send).toHaveBeenCalledWith(SHORTCUTS_BINDINGS_CHANGED_CHANNEL);
	});
});

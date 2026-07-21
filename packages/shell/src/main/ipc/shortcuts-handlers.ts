/**
 * `shortcuts:*` IPC handlers — surface the live shortcut registry to the
 * privileged dashboard renderer (Settings → Keyboard + the cheatsheet
 * overlay).
 *
 * **6.10f.** Closes the round-trip the doc-24 personal-entity contract
 * promised: a user-rebound chord persists through
 * `brainstorm/ShortcutBindings/v1` (Stage 9 entity-backed; flat-file
 * migration is idempotent) and the renderer sees the new effective
 * chord on every `bindings-changed` push.
 *
 * Mirrors the `bin:*` / `marketplace:*` pattern — privileged
 * dashboard-only, never broker (so a sandboxed app can't rebind shell
 * chords on the user's behalf).
 *
 * Channels:
 *   - `shortcuts:list`            → ShortcutBindingRow[]
 *   - `shortcuts:set-override`    → { ok: true } | { ok: false; reason }
 *   - `shortcuts:reset-override`  → { ok: true } | { ok: false; reason }
 *   - `shortcuts:bindings-changed`  push (no payload — renderer re-fetches)
 *
 * The set/reset verbs accept the chord in **`Mod`-tokenized** canonical
 * form (per `chord-capture.ts`); the normalize layer collapses `Mod` to
 * `cmdorctrl` for the matcher, so the on-disk shape stays
 * platform-portable.
 *
 * Persistence is fail-soft: an entity-write error doesn't roll back the
 * in-memory registry (the user's intent is honoured for the session)
 * but logs the failure. A subsequent successful write reconciles.
 */

import {
	BindingSource,
	ResetOverrideErrorReason,
	type ResetOverrideResult,
	SetOverrideErrorReason,
	type SetOverrideResult,
	type ShortcutBindingRow,
} from "@brainstorm-os/protocol/shortcut-binding-types";
import { type WebContents, ipcMain } from "electron";
import { writeOverridesToEntity } from "../shortcuts/bindings-entity";
import { normalizeChord } from "../shortcuts/chord";
import type { ResolvedBinding, ShortcutRegistry } from "../shortcuts/shortcut-registry";
import type { EntitiesRepository } from "../storage/entities-repo";

export const SHORTCUTS_LIST_CHANNEL = "shortcuts:list" as const;
export const SHORTCUTS_SET_OVERRIDE_CHANNEL = "shortcuts:set-override" as const;
export const SHORTCUTS_RESET_OVERRIDE_CHANNEL = "shortcuts:reset-override" as const;
export const SHORTCUTS_BINDINGS_CHANGED_CHANNEL = "shortcuts:bindings-changed" as const;

/** Re-export from the renderer-safe types module so existing consumers that
 *  imported these from `shortcuts-handlers.ts` keep working. The canonical
 *  declarations now live in `packages/shell/src/shortcut-binding-types.ts`
 *  so the renderer can value-import them without dragging `electron` into
 *  the renderer bundle (commit-`66db417` `sync-status-types` pattern). */
export {
	BindingSource,
	ResetOverrideErrorReason,
	type ResetOverrideResult,
	SetOverrideErrorReason,
	type SetOverrideResult,
	type ShortcutBindingRow,
};

export type ShortcutsHandlersOptions = {
	getRegistry: () => ShortcutRegistry | null;
	/** Active vault's `entities.db` repo for persistence. `null` when no
	 *  vault is open — the override still lands in the in-memory registry
	 *  (so the session honours it) and the persist path is skipped. */
	getRepo: () => Promise<EntitiesRepository | null>;
	/** Dashboard WebContents for the push event. Optional — the renderer
	 *  also re-fetches when its mount listener re-subscribes. */
	getDashboard: () => WebContents | null;
};

export function registerShortcutsHandlers(options: ShortcutsHandlersOptions): void {
	const broadcastChange = (): void => {
		const dashboard = options.getDashboard();
		if (dashboard && !dashboard.isDestroyed()) {
			dashboard.send(SHORTCUTS_BINDINGS_CHANGED_CHANNEL);
		}
	};

	const persistOverrides = async (registry: ShortcutRegistry): Promise<void> => {
		try {
			const repo = await options.getRepo();
			if (!repo) return;
			writeOverridesToEntity(repo, registry.snapshotOverrides());
		} catch (error) {
			console.error(
				`[brainstorm] shortcuts: persist failed — in-memory override stays: ${(error as Error).message}`,
			);
		}
	};

	ipcMain.handle(SHORTCUTS_LIST_CHANNEL, async (): Promise<ShortcutBindingRow[]> => {
		const registry = options.getRegistry();
		if (!registry) return [];
		return registry.listAll().map(toRow);
	});

	ipcMain.handle(
		SHORTCUTS_SET_OVERRIDE_CHANNEL,
		async (_event, idArg: unknown, chordArg: unknown): Promise<SetOverrideResult> => {
			const registry = options.getRegistry();
			if (!registry) return { ok: false, reason: SetOverrideErrorReason.NoRegistry };

			const id = typeof idArg === "string" ? idArg : "";
			if (id === "" || registry.resolve(id) === null) {
				return { ok: false, reason: SetOverrideErrorReason.UnknownId };
			}

			// `null` is "clear binding to nothing" (the action stays accessible
			// via menus / palette per §Shell layer "never disabled out
			// of existence"). A non-string non-null is malformed.
			if (chordArg !== null && typeof chordArg !== "string") {
				return { ok: false, reason: SetOverrideErrorReason.EmptyChord };
			}

			if (typeof chordArg === "string") {
				const trimmed = chordArg.trim();
				if (trimmed === "") {
					return { ok: false, reason: SetOverrideErrorReason.EmptyChord };
				}
				// A bare modifier ("Shift", "Mod", …) isn't a usable chord —
				// the registry would accept it, but the matcher would never
				// fire. Reject at the boundary so the renderer can keep its
				// capture surface armed.
				const parts = trimmed
					.split("+")
					.map((p) => p.trim())
					.filter(Boolean);
				if (parts.length === 0) {
					return { ok: false, reason: SetOverrideErrorReason.EmptyChord };
				}
				const onlyModifiers = parts.every((p) => MODIFIER_TOKENS.has(p.toLowerCase()));
				if (onlyModifiers) {
					return { ok: false, reason: SetOverrideErrorReason.BareModifier };
				}

				// Conflict detection: a chord already used by another
				// (different-id) binding in the same effective set. The
				// renderer warns *before* calling; this is the defensive
				// last-mile so a stale renderer can't end-run the warning.
				const normalized = normalizeChord(trimmed);
				const collisions = registry.findByChord(trimmed).filter((b) => b.action.id !== id);
				if (collisions.length > 0 && normalized !== "") {
					return { ok: false, reason: SetOverrideErrorReason.Conflict };
				}

				registry.overrideOne(id, trimmed);
			} else {
				// `null` — explicit "clear" (chord wiped, action stays).
				registry.overrideOne(id, null);
			}

			await persistOverrides(registry);
			broadcastChange();
			return { ok: true };
		},
	);

	ipcMain.handle(
		SHORTCUTS_RESET_OVERRIDE_CHANNEL,
		async (_event, idArg: unknown): Promise<ResetOverrideResult> => {
			const registry = options.getRegistry();
			if (!registry) return { ok: false, reason: ResetOverrideErrorReason.NoRegistry };

			const id = typeof idArg === "string" ? idArg : "";
			if (id === "" || registry.resolve(id) === null) {
				return { ok: false, reason: ResetOverrideErrorReason.UnknownId };
			}

			registry.resetOverride(id);
			await persistOverrides(registry);
			broadcastChange();
			return { ok: true };
		},
	);
}

/** Map the registry's `ResolvedBinding["source"]` literal union into the
 *  wire `BindingSource` enum. Wire values are byte-identical so this is
 *  a typed pass-through, but doing it explicitly catches future drift if
 *  the registry adds a new source kind. */
function toBindingSource(source: ResolvedBinding["source"]): BindingSource {
	switch (source) {
		case "default":
			return BindingSource.Default;
		case "user-override":
			return BindingSource.UserOverride;
		case "cleared":
			return BindingSource.Cleared;
	}
}

const MODIFIER_TOKENS = new Set([
	"mod",
	"cmd",
	"command",
	"meta",
	"super",
	"cmdorctrl",
	"commandorcontrol",
	"ctrl",
	"control",
	"alt",
	"option",
	"shift",
]);

function toRow(binding: ResolvedBinding): ShortcutBindingRow {
	const row: ShortcutBindingRow = {
		id: binding.action.id,
		layer: binding.action.layer,
		label: binding.action.label,
		chord: binding.chord,
		defaultChord: binding.action.defaultChord,
		source: toBindingSource(binding.source),
	};
	if (binding.action.appId !== undefined) {
		(row as { appId?: string }).appId = binding.action.appId;
	}
	if (binding.action.shadowsShell === true) {
		(row as { shadowsShell?: boolean }).shadowsShell = true;
	}
	if (binding.action.dynamic === true) {
		(row as { dynamic?: boolean }).dynamic = true;
	}
	return row;
}

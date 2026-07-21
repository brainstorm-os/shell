/**
 * Renderer-safe IPC-boundary types for Stage 6.10f shortcut rebinding.
 *
 * Both `preload/index.ts` and `main/ipc/shortcuts-handlers.ts` declare the
 * wire-level shape of `shortcuts:list` / `shortcuts:set-override` /
 * `shortcuts:reset-override` — without this module they each kept their own
 * copy (the comment in preload even said "re-declared here so the renderer
 * never imports main code"). The duplication was a workaround for a
 * different trap: the renderer's value-import of `BindingSource` /
 * `SetOverrideErrorReason` through the preload barrel was dragging
 * `import { contextBridge, ipcRenderer } from "electron"` into the renderer
 * bundle (Vite externalizes `path` + `__dirname` → runtime crash on first
 * dashboard mount, see CLAUDE.md "renderer never imports main code").
 *
 * The fix mirrors `sync-status-types.ts` (commit `66db417`): the enums +
 * wire types live here in a module that imports nothing from `electron` or
 * anywhere in the main process. Main, preload, and renderer all import
 * from here — the renderer no longer has to go through preload to read a
 * `BindingSource` value, so the preload's Electron imports stay
 * preload-local and never reach the renderer bundle.
 *
 * The on-disk JSON shape and the wire-channel payload shape are unchanged.
 * `BindingSource` is a string-typed TS enum whose values are the same wire
 * strings the prior union shape produced, so this is purely an import-graph
 * refactor.
 */

/** Origin of the effective chord on a resolved binding. Wire-level enum so
 *  consumers (Settings → Keyboard) can dispatch without parsing string
 *  literals. Values are stable wire strings (string-typed enum = identical
 *  to the prior union shape on the JSON surface). */
export enum BindingSource {
	Default = "default",
	UserOverride = "user-override",
	Cleared = "cleared",
}

/** Wire shape for one resolved shortcut row delivered by `shortcuts:list`.
 *  The renderer translates `label` via `t()` for known shell ids; app-layer
 *  ids fall back to the registry label verbatim. */
export type ShortcutBindingRow = {
	readonly id: string;
	readonly layer: "shell" | "app";
	readonly appId?: string;
	readonly label: string;
	readonly chord: string | null;
	readonly defaultChord: string | null;
	readonly source: BindingSource;
	readonly shadowsShell?: boolean;
	readonly dynamic?: boolean;
};

/** Reasons the `shortcuts:set-override` path can refuse. Enum-style so the
 *  renderer can dispatch on the failure (e.g. "this chord already binds
 *  X"). */
export enum SetOverrideErrorReason {
	UnknownId = "unknown-id",
	NoRegistry = "no-registry",
	EmptyChord = "empty-chord",
	BareModifier = "bare-modifier",
	Conflict = "conflict",
}

/** Reasons the `shortcuts:reset-override` path can refuse. */
export enum ResetOverrideErrorReason {
	UnknownId = "unknown-id",
	NoRegistry = "no-registry",
}

export type SetOverrideResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: SetOverrideErrorReason };

export type ResetOverrideResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: ResetOverrideErrorReason };

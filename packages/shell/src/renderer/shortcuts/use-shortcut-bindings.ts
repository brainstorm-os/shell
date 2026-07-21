/**
 * `useShortcutBindings()` — live snapshot of the main-process shortcut
 * registry, with chord-by-id and live-update subscription.
 *
 * Fetches via `brainstorm.shortcuts.list()` on mount + re-fetches on
 * every `shortcuts:bindings-changed` push (user rebind, vault switch,
 * app install/uninstall, dynamic-binding flux). Tolerates a stale or
 * missing bridge by falling back to the renderer-side
 * `defaultChordFor()` seed — so the Settings panel + cheatsheet always
 * render *something* even pre-vault-open.
 *
 * Returns a stable map (`Map<id, chord | null>`) plus the raw row list
 * for callers that need labels / `defaultChord` / `source` / app-layer
 * metadata.
 */

import {
	BindingSource,
	type ShortcutBindingRow,
} from "@brainstorm-os/protocol/shortcut-binding-types";
import { useEffect, useState } from "react";
import { defaultChordFor } from "./default-chords";

export type ShortcutBindings = {
	readonly rows: ReadonlyArray<ShortcutBindingRow>;
	readonly chordFor: (id: string) => string | null;
	readonly rowFor: (id: string) => ShortcutBindingRow | null;
};

type BridgeShortcuts = {
	list(): Promise<ShortcutBindingRow[]>;
	onBindingsChanged(listener: () => void): () => void;
};

function bridge(): BridgeShortcuts | null {
	const win = typeof window === "undefined" ? null : window;
	const wb = win as (Window & { brainstorm?: { shortcuts?: BridgeShortcuts } }) | null;
	return wb?.brainstorm?.shortcuts ?? null;
}

/** Build a fast lookup over a snapshot. The map is stable across
 *  re-fetches that produce structurally-identical data so callers can
 *  use it as a memoization key. */
function indexRows(rows: ReadonlyArray<ShortcutBindingRow>): {
	readonly chordByid: ReadonlyMap<string, string | null>;
	readonly rowById: ReadonlyMap<string, ShortcutBindingRow>;
} {
	const chordByid = new Map<string, string | null>();
	const rowById = new Map<string, ShortcutBindingRow>();
	for (const row of rows) {
		chordByid.set(row.id, row.chord);
		rowById.set(row.id, row);
	}
	return { chordByid, rowById };
}

const EMPTY: ReadonlyArray<ShortcutBindingRow> = [];

export function useShortcutBindings(): ShortcutBindings {
	const [rows, setRows] = useState<ReadonlyArray<ShortcutBindingRow>>(EMPTY);

	useEffect(() => {
		const svc = bridge();
		if (!svc) return;
		let cancelled = false;
		const refetch = (): void => {
			void svc
				.list()
				.then((next) => {
					if (cancelled) return;
					setRows(next);
				})
				.catch(() => {
					// Stale preload during dev / no vault → keep what we have +
					// fall back to the seed map.
				});
		};
		refetch();
		const off = svc.onBindingsChanged(refetch);
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	const { chordByid, rowById } = indexRows(rows);
	return {
		rows,
		chordFor: (id) => (chordByid.has(id) ? (chordByid.get(id) ?? null) : defaultChordFor(id)),
		rowFor: (id) => rowById.get(id) ?? null,
	};
}

/** Test-only helper. Builds a snapshot from a plain `id → chord` map so
 *  unit tests can exercise consumers without the bridge wiring. */
export function buildShortcutBindingsForTests(
	chords: Record<string, string | null>,
): ShortcutBindings {
	const rows: ShortcutBindingRow[] = Object.entries(chords).map(([id, chord]) => ({
		id,
		layer: id.startsWith("shell/") ? ("shell" as const) : ("app" as const),
		label: id,
		chord,
		defaultChord: defaultChordFor(id),
		source: chord === defaultChordFor(id) ? BindingSource.Default : BindingSource.UserOverride,
	}));
	const { chordByid, rowById } = indexRows(rows);
	return {
		rows,
		chordFor: (id) => (chordByid.has(id) ? (chordByid.get(id) ?? null) : defaultChordFor(id)),
		rowFor: (id) => rowById.get(id) ?? null,
	};
}

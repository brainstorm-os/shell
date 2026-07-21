/**
 * Shortcut cheatsheet overlay — Stage 6.9, migrated to `@react-fancy-menus`
 * at Stage 8.8.
 *
 * In-context keyboard reference. The Settings → Keyboard panel is the
 * persistent twin (26-help-and-onboarding.md §Help vs Settings split);
 * this overlay is the "show me what I can press right now" surface, bound
 * to `shell/cheatsheet` (default chord `CmdOrCtrl+Shift+K`).
 *
 * The command-palette body is a fancy-menus ComposedBody: a SearchInput
 * panel above a sectioned list. Filtering stays the pure `filterGroups`
 * helper (matches label OR chord, drops empty groups) — the filtered,
 * flattened rows flow into the menu via `updateData`, so the menu's
 * built-in name-only filter never runs. `<Cheatsheet>` itself renders
 * nothing; it opens the menu on the shared store and bridges the menu's
 * close lifecycle back to the dashboard's `cheatsheetOpen` boolean.
 *
 * Forward iteration (OQ-CHEAT-1, not blocking): wire to the live
 * `aggregateCheatsheet` data so app-layer + dynamic + user-overridden
 * bindings appear. v1 leans on the renderer-side `defaultChordFor` seed.
 */

import {
	BodyKind,
	DimmerMode,
	Horizontal,
	type MenuConfig,
	MenuState,
	PanelKind,
	RowKind,
	SourceKind,
	Vertical,
	defineMenu,
	useMenu,
	useMenuState,
} from "@brainstorm-os/sdk/menus";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/t";
// `.cheatsheet__key` / `.cheatsheet__row-chord-empty` style the chord tokens
// rendered inside the menu's row captions (which portal to document.body).
import "./cheatsheet.css";
import { formatChord, isMacPlatform } from "../shortcuts/chord-display";
import { defaultChordFor } from "../shortcuts/default-chords";
import { SHORTCUT_GROUPS, type ShortcutGroup } from "../shortcuts/shortcut-groups";

export const CHEATSHEET_MENU_ID = "shell/cheatsheet-menu";

export type ResolvedRow = {
	readonly id: string;
	readonly label: string;
	readonly chord: string | null;
	readonly tokens: ReadonlyArray<string>;
};

export type ResolvedGroup = {
	readonly title: string;
	readonly rows: ReadonlyArray<ResolvedRow>;
};

export function resolveGroups(mac: boolean): ReadonlyArray<ResolvedGroup> {
	return SHORTCUT_GROUPS.map((group: ShortcutGroup) => ({
		title: t(group.titleKey),
		rows: group.rows.map((row) => {
			const chord = defaultChordFor(row.id);
			return {
				id: row.id,
				label: t(row.labelKey),
				chord,
				tokens: formatChord(chord, mac),
			};
		}),
	}));
}

/** Pure filter: keep only rows whose label or chord contains `query`
 *  (case-insensitive). Empty `query` returns the input groups unchanged.
 *  Groups with zero matching rows are omitted. */
export function filterGroups(
	groups: ReadonlyArray<ResolvedGroup>,
	query: string,
): ReadonlyArray<ResolvedGroup> {
	const needle = query.trim().toLowerCase();
	if (needle === "") return groups;
	const out: ResolvedGroup[] = [];
	for (const group of groups) {
		const rows = group.rows.filter((r) =>
			`${r.label} ${r.chord ?? ""}`.toLowerCase().includes(needle),
		);
		if (rows.length > 0) out.push({ title: group.title, rows });
	}
	return out;
}

/** One row in the flattened command-palette list — a section header or a
 *  shortcut row. The list's row specs select by `kind`. */
export type CheatItem =
	| { readonly kind: "section"; readonly id: string; readonly title: string }
	| {
			readonly kind: "row";
			readonly id: string;
			readonly label: string;
			readonly tokens: ReadonlyArray<string>;
	  };

/** Flatten grouped rows into the single ordered list the menu renders:
 *  a section-header item, then its shortcut rows, per group. */
export function flattenGroups(groups: ReadonlyArray<ResolvedGroup>): CheatItem[] {
	const out: CheatItem[] = [];
	for (const group of groups) {
		out.push({ kind: "section", id: `section:${group.title}`, title: group.title });
		for (const row of group.rows) {
			out.push({ kind: "row", id: row.id, label: row.label, tokens: row.tokens });
		}
	}
	return out;
}

type CheatData = { items: CheatItem[] };

function chordTokens(item: Extract<CheatItem, { kind: "row" }>): ReactNode {
	if (item.tokens.length === 0) {
		return <span className="cheatsheet__row-chord-empty">{t("shell.cheatsheet.unbound")}</span>;
	}
	return item.tokens.map((token, i) => (
		<kbd key={`${item.id}-${i}`} className="cheatsheet__key">
			{token}
		</kbd>
	));
}

/** Stable handler box so the config (built once) reads the latest setters. */
type Handlers = { onQuery: (value: string) => void };

function buildConfig(handlers: { current: Handlers }): MenuConfig<CheatData> {
	return defineMenu<CheatData>({
		id: CHEATSHEET_MENU_ID,
		chrome: {
			title: t("shell.cheatsheet.title"),
			role: "dialog",
			withClose: true,
			dimmer: DimmerMode.Default,
			className: "cheatsheet-menu",
		},
		position: {
			vertical: Vertical.Center,
			horizontal: Horizontal.Center,
			width: 560,
			fillViewport: true,
		},
		body: {
			kind: BodyKind.Composed,
			sections: [
				{
					id: "search",
					kind: PanelKind.SearchInput,
					placeholder: t("shell.cheatsheet.searchPlaceholder"),
					focusOnMount: true,
					onChange: (value) => handlers.current.onQuery(value),
					onClear: () => handlers.current.onQuery(""),
				},
				{
					id: "list",
					kind: BodyKind.List,
					source: { kind: SourceKind.Prop, getItems: (data: CheatData) => data.items },
					rows: [
						{
							kind: RowKind.Section,
							match: (it: CheatItem) => it.kind === "section",
							name: (it: CheatItem) => (it.kind === "section" ? it.title : ""),
						},
						{
							kind: RowKind.Item,
							match: (it: CheatItem) => it.kind === "row",
							readonly: true,
							name: (it: CheatItem) => (it.kind === "row" ? it.label : ""),
							caption: (it: CheatItem) => (it.kind === "row" ? chordTokens(it) : null),
						},
					],
					emptyState: { kind: PanelKind.EmptyState, message: t("shell.cheatsheet.empty") },
				},
			],
		},
		keyboard: { defaults: { closeOnEscape: true } },
	});
}

export type CheatsheetProps = {
	readonly onClose: () => void;
};

export function Cheatsheet({ onClose }: CheatsheetProps) {
	const mac = useMemo(isMacPlatform, []);
	const groups = useMemo(() => resolveGroups(mac), [mac]);
	const [query, setQuery] = useState("");

	const { open, close, register, updateData } = useMenu();
	const state = useMenuState(CHEATSHEET_MENU_ID);

	const handlersRef = useRef<Handlers>({ onQuery: setQuery });
	handlersRef.current.onQuery = setQuery;
	const config = useMemo(() => buildConfig(handlersRef), []);

	const items = useMemo(() => flattenGroups(filterGroups(groups, query)), [groups, query]);

	// Open once on mount; close on unmount. The dashboard already gates this
	// component behind `cheatsheetOpen`, so mount == open intent.
	const openedRef = useRef(false);
	useEffect(() => {
		register(config);
		open(CHEATSHEET_MENU_ID, { data: { items: flattenGroups(groups) } });
		openedRef.current = true;
		return () => close(CHEATSHEET_MENU_ID);
	}, [open, close, register, config, groups]);

	// Push the filtered rows into the open menu as the query changes.
	useEffect(() => {
		if (openedRef.current) updateData(CHEATSHEET_MENU_ID, { items });
	}, [items, updateData]);

	// Bridge the menu's own dismissal (Escape / backdrop / close button) back
	// to the dashboard boolean so the conditional unmounts cleanly.
	const wasOpenRef = useRef(false);
	useEffect(() => {
		if (state === MenuState.Open || state === MenuState.Opening) {
			wasOpenRef.current = true;
		} else if (wasOpenRef.current && state === MenuState.Closed) {
			wasOpenRef.current = false;
			onClose();
		}
	}, [state, onClose]);

	return null;
}

/**
 * Recent emoji + icons (8.11) — the bounded "Recent" row at the top of the
 * picker's Emoji and Icons tabs. Shared by the SDK `<IconPicker>` and the
 * shell's own picker so both record and read the same shape.
 *
 * Persisted in this renderer's `localStorage` (one list per user profile per
 * surface): newest first, de-duplicated by `kind` + `value`, capped at
 * `RECENT_ICONS_CAP`. Only emoji and pack glyphs are recorded — an uploaded
 * image already has its own Library tab. Every read re-validates the stored
 * blob, so corruption (or a hostile write) degrades to an empty row.
 */

import { type Icon, IconKind } from "@brainstorm-os/sdk-types";
import { useCallback, useState } from "react";

export const RECENT_ICONS_CAP = 24;
export const RECENT_ICONS_STORAGE_KEY = "bs.icon-picker.recents.v1";
const MAX_VALUE_LENGTH = 128;

export type RecentIcon =
	| { kind: IconKind.Emoji; value: string }
	| { kind: IconKind.Pack; value: string };

function toRecent(icon: unknown): RecentIcon | null {
	if (!icon || typeof icon !== "object") return null;
	const { kind, value } = icon as Record<string, unknown>;
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_VALUE_LENGTH)
		return null;
	if (kind === IconKind.Emoji) return { kind: IconKind.Emoji, value };
	if (kind === IconKind.Pack) return { kind: IconKind.Pack, value };
	return null;
}

/** Record `icon` as most recent. Non-recordable icons leave `list` as is. */
export function pushRecentIcon(
	list: readonly RecentIcon[],
	icon: Icon,
	cap: number = RECENT_ICONS_CAP,
): RecentIcon[] {
	const next = toRecent(icon);
	if (!next) return [...list];
	const rest = list.filter((r) => !(r.kind === next.kind && r.value === next.value));
	return [next, ...rest].slice(0, cap);
}

export function parseRecentIcons(raw: unknown, cap: number = RECENT_ICONS_CAP): RecentIcon[] {
	if (!Array.isArray(raw)) return [];
	const out: RecentIcon[] = [];
	for (const entry of raw) {
		const recent = toRecent(entry);
		if (recent && !out.some((r) => r.kind === recent.kind && r.value === recent.value)) {
			out.push(recent);
		}
		if (out.length >= cap) break;
	}
	return out;
}

function storage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function loadRecentIcons(store: Storage | null = storage()): RecentIcon[] {
	try {
		const raw = store?.getItem(RECENT_ICONS_STORAGE_KEY);
		return raw ? parseRecentIcons(JSON.parse(raw)) : [];
	} catch {
		return [];
	}
}

export function recordRecentIcon(icon: Icon, store: Storage | null = storage()): RecentIcon[] {
	const next = pushRecentIcon(loadRecentIcons(store), icon);
	try {
		store?.setItem(RECENT_ICONS_STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Storage full / blocked: the row just won't remember this pick.
	}
	return next;
}

/** The recents snapshot for one open picker + a recorder for its picks. */
export function useRecentIcons(): {
	recents: readonly RecentIcon[];
	record: (icon: Icon) => void;
} {
	const [recents, setRecents] = useState<readonly RecentIcon[]>(() => loadRecentIcons());
	const record = useCallback((icon: Icon) => {
		setRecents(recordRecentIcon(icon));
	}, []);
	return { recents, record };
}

export function recentsOfKind(
	recents: readonly RecentIcon[],
	kind: IconKind.Emoji | IconKind.Pack,
): string[] {
	return recents.filter((r) => r.kind === kind).map((r) => r.value);
}

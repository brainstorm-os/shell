/**
 * Tray host (Stage 7.8) — `services.ui.tray.publish/clear`.
 *
 * There is **one** shell-owned OS tray. A `tray.publish`-granted app
 * contributes a *section* (a header + its items) to that single tray's
 * native context menu; the shell composes the final menu from every
 * publisher. Clicking an item with an `intent` routes through the
 * existing shell `IntentsBus` attributed to the publishing app — the
 * tray reuses the curated-verb path rather than inventing an app
 * callback channel (so 7.8 doesn't depend on the still-deferred
 * `runtime:lifecycle` push).
 *
 * `TrayHost` is **pure** (no Electron imports) so the validation +
 * menu-composition is unit-tested without a window: it stores per-app
 * sections, recomputes a plain-data menu template, and hands it to an
 * injected `onChange`. The Electron `Tray` / `Menu` construction + the
 * click → `IntentsBus.dispatch` wiring live in `main/index.ts`, mirroring
 * how `notify-host` keeps Electron out of the testable core.
 *
 * v1 renders OS-native; the `fancy-menus` app-rendered tray
 * (§Tray menu) is the later upgrade
 * once that Stage-8 dep lands — see OQ-TRAY-1.
 */

const MAX_ITEMS_PER_APP = 24;
const MAX_LABEL = 80;
const MAX_TOOLTIP = 120;
const BASE_TOOLTIP = "Brainstorm";

export type TrayIntent = { verb: string; payload: Record<string, unknown> };

/** A validated item belonging to one publishing app. */
export type TraySectionItem = {
	id: string;
	label: string;
	enabled: boolean;
	intent?: TrayIntent;
};

type Section = {
	tooltip?: string;
	items: TraySectionItem[];
};

/** Plain-data menu model the Electron layer turns into a `Menu`. */
export type ComposedTrayEntry =
	| { kind: "header"; appId: string }
	| { kind: "separator" }
	| { kind: "shell"; action: TrayShellAction; label: string }
	| {
			kind: "item";
			appId: string;
			itemId: string;
			label: string;
			enabled: boolean;
			intent?: TrayIntent;
	  };

export type ComposedTray = {
	tooltip: string;
	entries: ComposedTrayEntry[];
};

/** 7.16 — the shell's own tray items, present while "Keep running in the
 *  background" is on so a windowless process always has a way back (and out). */
export enum TrayShellAction {
	Open = "open",
	Quit = "quit",
}

export type TrayShellItem = { action: TrayShellAction; label: string };

export type TrayChangeListener = (tray: ComposedTray | null) => void;

export class TrayHost {
	/** Insertion-ordered so the tray menu is stable as apps publish. */
	private readonly sections = new Map<string, Section>();
	private shellItems: readonly TrayShellItem[] = [];
	private onChange: TrayChangeListener = () => undefined;

	setListener(listener: TrayChangeListener): void {
		this.onChange = listener;
	}

	publish(appId: string, raw: unknown): void {
		this.sections.delete(appId); // re-publish replaces; keeps newest at the end
		this.sections.set(appId, normalizeSpec(raw));
		this.emit();
	}

	clear(appId: string): void {
		if (this.sections.delete(appId)) this.emit();
	}

	/** Install (non-empty) or remove (empty) the shell's own items. They lead
	 *  the menu and keep the tray alive with no app publishing. */
	setShellItems(items: readonly TrayShellItem[]): void {
		if (items.length === 0 && this.shellItems.length === 0) return;
		this.shellItems = [...items];
		this.emit();
	}

	/** Drop every publisher (e.g. on vault close) and tear the tray down. */
	reset(): void {
		if (this.sections.size === 0) return;
		this.sections.clear();
		this.emit();
	}

	/** Pure menu model — `null` when neither an app nor the shell has items
	 *  (the tray is torn down rather than left as an empty icon). */
	compose(): ComposedTray | null {
		if (this.sections.size === 0 && this.shellItems.length === 0) return null;
		const entries: ComposedTrayEntry[] = this.shellItems.map((item) => ({
			kind: "shell" as const,
			action: item.action,
			label: item.label,
		}));
		if (entries.length > 0 && this.sections.size > 0) entries.push({ kind: "separator" });
		let first = true;
		for (const [appId, section] of this.sections) {
			if (!first) entries.push({ kind: "separator" });
			first = false;
			entries.push({ kind: "header", appId });
			for (const item of section.items) {
				entries.push({
					kind: "item",
					appId,
					itemId: item.id,
					label: item.label,
					enabled: item.enabled,
					...(item.intent ? { intent: item.intent } : {}),
				});
			}
		}
		return { tooltip: this.resolveTooltip(), entries };
	}

	/** A single publisher with a tooltip names the tray; otherwise the
	 *  shared product tooltip (a multi-app tray can't speak for one app). */
	private resolveTooltip(): string {
		if (this.sections.size === 1) {
			const only = [...this.sections.values()][0];
			if (only?.tooltip) return only.tooltip;
		}
		return BASE_TOOLTIP;
	}

	private emit(): void {
		this.onChange(this.compose());
	}
}

function normalizeSpec(raw: unknown): Section {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw invalid("ui.tray.publish: argument must be an object");
	}
	const r = raw as Record<string, unknown>;
	if (!Array.isArray(r.items)) {
		throw invalid("ui.tray.publish: { items } must be an array");
	}
	if (r.items.length === 0) {
		throw invalid("ui.tray.publish: { items } must not be empty (use tray.clear to remove)");
	}
	if (r.items.length > MAX_ITEMS_PER_APP) {
		throw invalid(`ui.tray.publish: at most ${MAX_ITEMS_PER_APP} items per app`);
	}
	const section: Section = { items: r.items.map(normalizeItem) };
	if (r.tooltip !== undefined) {
		if (typeof r.tooltip !== "string") {
			throw invalid("ui.tray.publish: { tooltip } must be a string when present");
		}
		const tip = clamp(r.tooltip, MAX_TOOLTIP);
		if (tip.length > 0) section.tooltip = tip;
	}
	return section;
}

function normalizeItem(raw: unknown, index: number): TraySectionItem {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw invalid(`ui.tray.publish: items[${index}] must be an object`);
	}
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || r.id.trim().length === 0) {
		throw invalid(`ui.tray.publish: items[${index}].id must be a non-empty string`);
	}
	if (typeof r.label !== "string" || r.label.trim().length === 0) {
		throw invalid(`ui.tray.publish: items[${index}].label must be a non-empty string`);
	}
	const item: TraySectionItem = {
		id: r.id.trim(),
		label: clamp(r.label, MAX_LABEL),
		enabled: r.enabled === undefined ? true : r.enabled === true,
	};
	if (r.intent !== undefined) {
		item.intent = normalizeIntent(r.intent, index);
	}
	return item;
}

function normalizeIntent(raw: unknown, index: number): TrayIntent {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw invalid(`ui.tray.publish: items[${index}].intent must be an object`);
	}
	const r = raw as Record<string, unknown>;
	if (typeof r.verb !== "string" || r.verb.trim().length === 0) {
		throw invalid(`ui.tray.publish: items[${index}].intent.verb must be a non-empty string`);
	}
	let payload: Record<string, unknown> = {};
	if (r.payload !== undefined) {
		if (!r.payload || typeof r.payload !== "object" || Array.isArray(r.payload)) {
			throw invalid(`ui.tray.publish: items[${index}].intent.payload must be an object`);
		}
		payload = r.payload as Record<string, unknown>;
	}
	return { verb: r.verb.trim(), payload };
}

function clamp(value: string, max: number): string {
	const trimmed = value.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function invalid(message: string): Error {
	const err = new Error(message);
	err.name = "Invalid";
	return err;
}

// ─── Module singleton (mirrors getUiNotifyHost) ─────────────────────────────

let host: TrayHost | null = null;

export function getTrayHost(): TrayHost {
	if (!host) host = new TrayHost();
	return host;
}

export function resetTrayHost(): void {
	host = null;
}

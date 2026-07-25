/**
 * Chrome-cell contract (Stage 8.4) — the data a shell-rendered chrome
 * cell needs, and the typed options each kind reads from the layout.
 *
 * **OQ-90 is resolved here as (a): the chrome-kind set is SHELL-CURATED
 * and closed.** `ChromeKind` in the frozen `Layout/v1` contract is the
 * whole set; an app cannot register a seventh. The reasoning is the same
 * one doc 27 gives for why chrome internals aren't customizable: a
 * chrome cell is *shell-rendered by definition* — it draws with the
 * active theme, opens menus through the shared runtime, and carries the
 * shell's a11y semantics. A kind an app defines would have none of that,
 * and the escape hatch already exists and is better: a `block` cell,
 * which the app renders itself with no pretence of being shell chrome.
 * An open set would also make every layout's portability depend on which
 * apps happen to be installed.
 *
 * The split of responsibility: the SDK owns the *kinds* and how they
 * render; the **host owns the data** (what the actions are, what the
 * breadcrumb trail is, what the tabs are). Chrome can't know an app's
 * navigation any more than an app should re-draw the shell's chrome.
 */

import type { ReactNode } from "react";
import type { EntityRow } from "../in-memory-entities";

/** Horizontal placement of a chrome cell's content within its cell box. */
export enum ChromeAlignment {
	Start = "start",
	Center = "center",
	End = "end",
}

/** The standard entity actions every `actionBar` can offer. A host
 *  supplies the ones that apply; a layout may narrow + order them via
 *  the cell's `buttons` option. Ids are an enum, not bare strings, so a
 *  typo in a layout is a validation failure rather than a missing
 *  button. */
export enum ChromeActionId {
	Open = "open",
	Share = "share",
	Rename = "rename",
	Duplicate = "duplicate",
	Delete = "delete",
	More = "more",
}

export type ChromeAction = {
	/** A canonical id, or an app-registered intent id (doc 27's
	 *  "app-registered intent buttons"). */
	id: ChromeActionId | string;
	label: string;
	icon?: ReactNode;
	disabled?: boolean;
	/** `More` conventionally opens the shared object menu — the host does
	 *  that, so the SDK never owns menu policy. The anchor is the button. */
	onSelect: (anchor: HTMLElement) => void;
};

export type ChromeCrumb = {
	id: string;
	label: string;
	icon?: ReactNode;
	/** Absent ⇒ the current (last) crumb, rendered as plain text. */
	onNavigate?: () => void;
};

export type ChromeMetaField = {
	id: string;
	label: string;
	value: string;
};

export type ChromeTab = {
	id: string;
	label: string;
	icon?: ReactNode;
	active?: boolean;
	onSelect: () => void;
	onClose?: () => void;
};

export type ChromeWindowControls = {
	closeLabel: string;
	minimizeLabel: string;
	maximizeLabel: string;
	onClose: () => void;
	onMinimize: () => void;
	onMaximize: () => void;
};

/**
 * Everything a chrome cell may draw from. Every field is optional: a
 * layout that asks for chrome the host has no data for renders an empty
 * (but present) element rather than throwing — a half-wired host is a
 * visible gap, not a crash.
 */
export type ChromeHost = {
	entity: EntityRow;
	title?: string;
	icon?: ReactNode;
	actions?: readonly ChromeAction[];
	breadcrumb?: readonly ChromeCrumb[];
	meta?: readonly ChromeMetaField[];
	tabs?: readonly ChromeTab[];
	windowControls?: ChromeWindowControls;
	/** Resolve an app-registered translation key. */
	t?: (key: string) => string;
};

// ─── Per-kind options ────────────────────────────────────────────────────────
//
// A `ChromeCell.options` is `Record<string, unknown>` in the frozen
// contract (8.1 deliberately left it opaque). These readers are what
// types it — each tolerates a missing / malformed value by falling back,
// so a hand-edited layout degrades instead of breaking the render.

export type ActionBarOptions = {
	alignment: ChromeAlignment;
	/** Narrow + order the host's actions. Absent ⇒ all of them, host order. */
	buttons?: readonly string[];
};

export type MetaOptions = {
	/** Which meta fields to show, in order. Absent ⇒ all of them. */
	fields?: readonly string[];
};

export type EntityHeaderOptions = {
	showIcon: boolean;
	showActions: boolean;
	alignment: ChromeAlignment;
};

export type BreadcrumbOptions = {
	/** Collapse the middle of a long trail to an ellipsis past this many
	 *  crumbs. 0 / absent ⇒ never collapse. */
	maxItems: number;
};

export type WindowControlsOptions = {
	alignment: ChromeAlignment;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

function readAlignment(options: unknown, fallback: ChromeAlignment): ChromeAlignment {
	if (!isRecord(options)) return fallback;
	const raw = options.alignment;
	return raw === ChromeAlignment.Start ||
		raw === ChromeAlignment.Center ||
		raw === ChromeAlignment.End
		? raw
		: fallback;
}

function readStringList(options: unknown, key: string): readonly string[] | undefined {
	if (!isRecord(options)) return undefined;
	const raw = options[key];
	if (!Array.isArray(raw)) return undefined;
	const list = raw.filter((entry): entry is string => typeof entry === "string");
	return list.length > 0 ? list : undefined;
}

function readBoolean(options: unknown, key: string, fallback: boolean): boolean {
	if (!isRecord(options)) return fallback;
	const raw = options[key];
	return typeof raw === "boolean" ? raw : fallback;
}

export function actionBarOptions(options: unknown): ActionBarOptions {
	const buttons = readStringList(options, "buttons");
	return {
		alignment: readAlignment(options, ChromeAlignment.End),
		...(buttons ? { buttons } : {}),
	};
}

export function metaOptions(options: unknown): MetaOptions {
	const fields = readStringList(options, "fields");
	return fields ? { fields } : {};
}

export function entityHeaderOptions(options: unknown): EntityHeaderOptions {
	return {
		showIcon: readBoolean(options, "showIcon", true),
		showActions: readBoolean(options, "showActions", true),
		alignment: readAlignment(options, ChromeAlignment.Start),
	};
}

export function breadcrumbOptions(options: unknown): BreadcrumbOptions {
	const raw = isRecord(options) ? options.maxItems : undefined;
	const maxItems = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
	return { maxItems };
}

export function windowControlsOptions(options: unknown): WindowControlsOptions {
	return { alignment: readAlignment(options, ChromeAlignment.End) };
}

/**
 * The actions an `actionBar` shows: narrowed + ordered by the layout's
 * `buttons` option when it has one, else the host's own order. A
 * `buttons` entry the host doesn't offer is dropped rather than rendered
 * as a dead button.
 */
export function selectActions(
	actions: readonly ChromeAction[],
	buttons: readonly string[] | undefined,
): readonly ChromeAction[] {
	if (!buttons) return actions;
	const byId = new Map(actions.map((action) => [action.id, action]));
	return buttons
		.map((id) => byId.get(id))
		.filter((action): action is ChromeAction => action !== undefined);
}

/** The meta fields a `meta` cell shows, narrowed + ordered the same way. */
export function selectMetaFields(
	fields: readonly ChromeMetaField[],
	wanted: readonly string[] | undefined,
): readonly ChromeMetaField[] {
	if (!wanted) return fields;
	const byId = new Map(fields.map((field) => [field.id, field]));
	return wanted
		.map((id) => byId.get(id))
		.filter((field): field is ChromeMetaField => field !== undefined);
}

/**
 * A breadcrumb trail collapsed to `maxItems`. The first and the last two
 * crumbs always survive — where you came from and where you are are the
 * two things a trail is for — with the middle replaced by one ellipsis
 * crumb. `maxItems` of 0 (or a trail already short enough) is a no-op.
 */
export const BREADCRUMB_ELLIPSIS_ID = "…";

export function collapseCrumbs(
	crumbs: readonly ChromeCrumb[],
	maxItems: number,
): readonly ChromeCrumb[] {
	if (maxItems <= 0 || crumbs.length <= maxItems || crumbs.length <= 3) return crumbs;
	const first = crumbs[0] as ChromeCrumb;
	const tail = crumbs.slice(-2);
	return [first, { id: BREADCRUMB_ELLIPSIS_ID, label: BREADCRUMB_ELLIPSIS_ID }, ...tail];
}

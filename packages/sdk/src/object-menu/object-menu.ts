/**
 * The shared **object menu** — the one cross-app contract for "what
 * actions can I take on this object?" (Stage 7.13).
 *
 * Every first-party app surfaces the same context menu on one of its
 * objects (a Database row, a Graph node, a Notes mention, a Files
 * entry…). Before this, each app hand-rolled its own item list with
 * subtly different labels, ordering and semantics. This module is the
 * single source of truth: same items, same order, same labels, same
 * behaviour — so a user who learns "right-click → Pin to dashboard" in
 * one app finds it in every app.
 *
 * Headless on purpose (no DOM, no React): it returns an ordered list of
 * `ObjectMenuItem` descriptors; each app renders them through its own
 * menu chrome (Database's `openContextMenu`, the shell's
 * `DashboardIconContextMenu`, …) so we don't fork menu styling. The
 * convention — including how to add app-specific items — is documented
 * in §Object menu.
 *
 * v1 items: **Open**, **Pin to dashboard / Remove from dashboard**,
 * then any app `extraItems` (future: Print, Duplicate, Move…), then
 * **Remove** (app-owned: delete the object / remove from a list). The
 * Pin toggle is gated on the `dashboard.pin` capability; Remove only
 * appears when the app passes an `onRemove` handler.
 */

import type { ContributedAction } from "@brainstorm-os/sdk-types";
import { IconName } from "../icon/icon-registry";
import { openEntity } from "../open-entity";

/** The object the menu acts on. `entityType` lets the open dispatch
 *  route to the type's registered opener; `label` is only used in
 *  default labels / confirmations the app may show. */
export type ObjectMenuTarget = {
	entityId: string;
	entityType?: string;
	label?: string;
};

/** One rendered menu entry. `run` is the activation; the host menu maps
 *  `label` / `destructive` / `disabled` onto its own item chrome. */
export type ObjectMenuItem = {
	/** Stable id for testing / host keying (`open`, `pin`, `remove`, …). */
	id: string;
	label: string;
	/** Leading glyph (an SDK `IconName`); the host menu paints it. */
	icon?: IconName;
	destructive?: boolean;
	disabled?: boolean;
	/** Tooltip explaining a `disabled` row (e.g. why Open is unavailable in
	 *  standalone mode). Rendered as the row's `title`. */
	hint?: string;
	/** Nested submenu. When set, the row shows a chevron and reveals these
	 *  children to its right on hover — the shared cascade pattern for grouped
	 *  option sets (a Diff-layout / Syntax-theme picker). A submenu parent is a
	 *  pure container, so its `run` never fires (pass a no-op). */
	submenu?: ObjectMenuItem[];
	run: () => void | Promise<void>;
};

/** An app-specific entry (Print, Duplicate, …) spliced in *before*
 *  Remove so destructive stays last. Same shape as a built-in item. */
export type ObjectMenuExtraItem = ObjectMenuItem;

/** Localisable labels — English defaults; an app passes its own `t()`
 *  output to keep menus in the user's language. */
export type ObjectMenuLabels = {
	open: string;
	/** Tooltip shown on the disabled Open row when the host can't dispatch the
	 *  open verb (standalone mode — no `services.intents.dispatch`). */
	openUnavailable: string;
	/** Parent row of the "Open with ▸ <app>" cascade, shown only when 2+ apps
	 *  can open the object. */
	openWith: string;
	pin: string;
	unpin: string;
	/** Collab-C5 "Share…" — opens the share dialog (member list + invite). */
	share: string;
	remove: string;
};

export const DEFAULT_OBJECT_MENU_LABELS: ObjectMenuLabels = {
	open: "Open",
	openUnavailable: "Running standalone — open this inside the shell to use it",
	openWith: "Open with",
	pin: "Pin to dashboard",
	unpin: "Remove from dashboard",
	share: "Share…",
	remove: "Remove",
};

/** One app that can open the target — a row in the "Open with ▸" cascade.
 *  `label` is the app's display name (resolved shell-side); the menu falls
 *  back to the bare `appId` only when a label is missing. */
export type OpenWithEntry = { appId: string; label: string };

const DASHBOARD_PIN_CAPABILITY = "dashboard.pin";
/** Collab-C5 — the scarce grant cap; only an app that holds it sees "Share…". */
export const SHARING_SHARE_CAPABILITY = "sharing.share";

/** Minimal runtime slice the menu needs — a superset of
 *  `OpenCapableRuntime` plus the dashboard pin surface and the granted
 *  capability list. Kept structural so tests pass a plain object. */
export type ObjectMenuRuntime = {
	capabilities?: readonly string[];
	services?: {
		intents?: {
			dispatch?: (i: { verb: string; payload: Record<string, unknown> }) => unknown;
			suggest?: (i: {
				verb: string;
				payload: Record<string, unknown>;
			}) => Promise<readonly { appId: string; label: string | null }[]>;
			/** The action surface (doc 63): the contributed actions other apps
			 *  offer on a target. Present only when the host runtime exposes it
			 *  (the standard app runtime does). Absent ⇒ no contributed actions
			 *  splice into the menu (the menu degrades to its built-ins). */
			suggestActions?: (input: {
				target: { entityId?: string; entityType?: string; mime?: string; format?: string };
				verbs: readonly string[];
			}) => Promise<readonly ContributedAction[]>;
		};
		dashboard?: {
			pin?: (t: { entityId: string }) => Promise<boolean>;
			unpin?: (t: { entityId: string }) => Promise<boolean>;
			isPinned?: (t: { entityId: string }) => Promise<boolean>;
		};
	} | null;
} | null;

export type BuildObjectMenuOptions = {
	target: ObjectMenuTarget;
	runtime: ObjectMenuRuntime;
	/** Current pin state — the caller pre-fetches it (via
	 *  `isObjectPinned`) so this builder stays pure + synchronous and
	 *  the menu can label Pin vs. Unpin without a flash. */
	pinned: boolean;
	/** Override the English defaults with the app's localised strings. */
	labels?: Partial<ObjectMenuLabels>;
	/** App-owned destructive action (delete the entity / remove from a
	 *  list). Omitted → no Remove item (e.g. a read-only surface). The
	 *  app owns the confirm; this just wires the menu entry. */
	onRemove?: () => void | Promise<void>;
	/** Collab-C5 — open the share dialog for this object. The item shows only
	 *  when the app ALSO holds the scarce `sharing.share` capability (the menu
	 *  gates the affordance; the service re-checks the grant). The app owns the
	 *  dialog mount; this just wires the menu entry. */
	onShare?: () => void | Promise<void>;
	/** App-specific items (Print, Duplicate…). Inserted after the
	 *  built-ins, before Remove, in array order. */
	extraItems?: ObjectMenuExtraItem[];
	/** Suppress the leading **Open** item. A header ⋯ whose target is the
	 *  object the app is ALREADY showing would offer "Open" on the current
	 *  view — a visible no-op (open-the-already-open). Such self-targeting
	 *  menus pass `omitOpen: true` so the menu carries only the actions that
	 *  still mean something there (Pin, Remove, app extras). */
	omitOpen?: boolean;
	/** The apps that can open this object (default first), pre-fetched by the
	 *  caller via `intents.suggest`. With 2+ entries the builder renders an
	 *  "Open with ▸" cascade so the user can pick a non-default viewer (a PDF →
	 *  Books or Preview). With 0–1 entries only the plain "Open" item shows —
	 *  there's no choice to offer. */
	openWithCandidates?: readonly OpenWithEntry[];
};

function hasCapability(runtime: ObjectMenuRuntime, capability: string): boolean {
	const caps = runtime?.capabilities;
	if (!caps) return false;
	// Grants may be bare (`dashboard.pin`) or scoped (`dashboard.pin:x`).
	return caps.some((c) => c === capability || c.startsWith(`${capability}:`));
}

/**
 * Build the ordered menu for an object. Pure + synchronous — no I/O
 * happens until an item's `run()` is invoked.
 */
export function buildObjectMenuItems(options: BuildObjectMenuOptions): ObjectMenuItem[] {
	const { target, runtime, pinned } = options;
	const labels = { ...DEFAULT_OBJECT_MENU_LABELS, ...options.labels };
	const items: ObjectMenuItem[] = [];

	// Open — routes through the one open path so it inherits focus-existing +
	// the registered opener (per §The
	// Link component). Disabled with a hint when the runtime can't dispatch
	// (standalone preview): clicking would silently no-op, so we say why
	// instead of offering a dead action.
	const canDispatch = Boolean(runtime?.services?.intents?.dispatch);
	if (!options.omitOpen) {
		items.push({
			id: "open",
			label: labels.open,
			icon: IconName.OpenExternal,
			...(canDispatch ? {} : { disabled: true, hint: labels.openUnavailable }),
			run: () => {
				void openEntity(runtime, {
					entityId: target.entityId,
					...(target.entityType ? { entityType: target.entityType } : {}),
				});
			},
		});
		// "Open with ▸ <app>" — only when more than one app claims the object
		// (e.g. a PDF → Books / Preview). With one opener the plain "Open" above
		// already routes there, so there's nothing to choose. Each child forces
		// its app via `handlerAppId`, overriding the default pick.
		const candidates = options.openWithCandidates ?? [];
		if (canDispatch && candidates.length > 1) {
			items.push({
				id: "open-with",
				label: labels.openWith,
				icon: IconName.OpenExternal,
				run: () => {},
				submenu: candidates.map((candidate) => ({
					id: `open-with:${candidate.appId}`,
					label: candidate.label || candidate.appId,
					run: () => {
						void openEntity(runtime, {
							entityId: target.entityId,
							handlerAppId: candidate.appId,
							...(target.entityType ? { entityType: target.entityType } : {}),
						});
					},
				})),
			});
		}
	}

	// Pin / Unpin — only when the app holds `dashboard.pin` and the
	// runtime actually exposes the surface (a thin/test runtime may not).
	const dashboard = runtime?.services?.dashboard;
	if (hasCapability(runtime, DASHBOARD_PIN_CAPABILITY) && dashboard) {
		items.push(
			pinned
				? {
						id: "unpin",
						label: labels.unpin,
						icon: IconName.PinSlash,
						run: () => {
							void dashboard.unpin?.({ entityId: target.entityId });
						},
					}
				: {
						id: "pin",
						label: labels.pin,
						icon: IconName.Pin,
						run: () => {
							void dashboard.pin?.({ entityId: target.entityId });
						},
					},
		);
	}

	// Share… — only when the app holds the scarce `sharing.share` grant cap.
	// The app provides `onShare` (it owns the dialog mount).
	if (options.onShare && hasCapability(runtime, SHARING_SHARE_CAPABILITY)) {
		const onShare = options.onShare;
		items.push({
			id: "share",
			label: labels.share,
			icon: IconName.KindLink,
			run: () => {
				void onShare();
			},
		});
	}

	if (options.extraItems) items.push(...options.extraItems);

	if (options.onRemove) {
		items.push({
			id: "remove",
			label: labels.remove,
			icon: IconName.Trash,
			destructive: true,
			run: options.onRemove,
		});
	}

	return items;
}

/**
 * Pre-fetch the pin state so the menu can be built synchronously with
 * the right Pin/Unpin label. Resolves `false` on any failure / missing
 * surface (the menu then offers Pin — the safe default).
 */
export async function isObjectPinned(
	runtime: ObjectMenuRuntime,
	entityId: string,
): Promise<boolean> {
	try {
		const isPinned = runtime?.services?.dashboard?.isPinned;
		if (!isPinned) return false;
		return await isPinned({ entityId });
	} catch {
		return false;
	}
}

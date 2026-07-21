/**
 * `openObjectMenu` — the pure-DOM object-menu renderer. The ONE place the
 * headless `buildObjectMenuItems` contract becomes a visible popup, so
 * every app shows the same Open / Pin·Unpin / … / Remove in the same order
 * with the same chrome (it renders through the shared `anchored-menu`).
 *
 * It pre-fetches the pin state (`isObjectPinned`) so the menu opens already
 * labelled Pin vs. Remove-from-dashboard with no flash, then maps each
 * `ObjectMenuItem` onto an anchored-menu row. The destructive `remove`
 * item gets the shared trash glyph; the rest stay label-only (matching the
 * proven Database menu so the migration is exact parity).
 *
 * 9.3.5.V 7c — when the host passes a `collections` service slice (and the
 * app holds `entities.write:brainstorm/List/v1`), an "Add to collection…"
 * item is spliced before Remove; activating it opens a second anchored menu
 * (at the same point) listing the user's Collections with a check on the
 * ones this object already belongs to. Toggling re-opens the picker so the
 * user can add to several in one gesture.
 */

import {
	ACTION_GROUP_ORDER,
	ActionGroup,
	type ContributedAction,
	type ContributedActionGroup,
	ContributedVerb,
	groupContributedActions,
} from "@brainstorm-os/sdk-types";
import { IconName } from "../icon/icon-registry";
import { MenuAlign } from "../menus";
import { OPEN_VERB } from "../open-entity";
import { type AnchoredMenuItem, closeAnchoredMenu, openAnchoredMenu } from "./anchored-menu";
import {
	COLLECTIONS_WRITE_CAPABILITY,
	type CollectionsEntitiesService,
	listCollectionsForObject,
	toggleCollectionMembership,
} from "./collections";
import { type ObjectMenuChromeLabels, resolveObjectMenuChromeLabels } from "./menu-labels";
import {
	type BuildObjectMenuOptions,
	type ObjectMenuExtraItem,
	type ObjectMenuItem,
	type ObjectMenuRuntime,
	type ObjectMenuTarget,
	type OpenWithEntry,
	buildObjectMenuItems,
	isObjectPinned,
} from "./object-menu";

const ADD_TO_COLLECTION_ITEM_ID = "add-to-collection";

/** The host-injected collection surface for the cross-app picker. Present
 *  only when the app exposes `services.entities` and wants the affordance. */
export type ObjectMenuCollections = {
	service: CollectionsEntitiesService;
	/** The app id recorded on a manual membership (`by: app:<id>`). */
	appId: string;
};

export type OpenObjectMenuOptions = Omit<BuildObjectMenuOptions, "pinned" | "labels"> & {
	/** Item + chrome strings. Defaults to English; a localised host passes
	 *  a `Partial<…>` of just the keys it translates. */
	labels?: Partial<ObjectMenuChromeLabels>;
	/** Cross-app "Add to collection" surface (9.3.5.V 7c). */
	collections?: ObjectMenuCollections;
	/** The ⋯ / trigger element the menu drops from. When given, the menu
	 *  anchors to its live rect, right-aligns to its edge, and the element
	 *  shows its open state. Omit for cursor-anchored (right-click) opens. */
	anchor?: HTMLElement;
	/** Cross-axis alignment override (defaults to right-edge for a button
	 *  trigger, left-edge for cursor menus). */
	align?: MenuAlign;
};

function toAnchoredItem(item: ObjectMenuItem): AnchoredMenuItem {
	return {
		label: item.label,
		onSelect: () => {
			void item.run();
		},
		destructive: item.destructive ?? false,
		disabled: item.disabled ?? false,
		// Each built-in / extra item carries its own glyph (Open, Pin/Unpin,
		// Remove, …); the host menu paints it.
		...(item.icon ? { icon: item.icon } : {}),
		...(item.hint ? { hint: item.hint } : {}),
		// Children flow through the same mapper so a cascade row matches a
		// top-level one and can itself nest.
		...(item.submenu ? { submenu: item.submenu.map(toAnchoredItem) } : {}),
	};
}

/** Map the built items to anchored rows, fencing the destructive action
 *  (Remove) off from the safe ones above with a single divider. That is the
 *  one clear semantic boundary in the object menu — "things that navigate /
 *  organise" vs "the action that destroys" — so a user never fat-fingers
 *  Remove while reaching for Pin. Over-dividing (a rule between every group)
 *  reads as noise, so we draw exactly this one, and only when something
 *  precedes the destructive row. */
function withSectionDividers(items: ObjectMenuItem[]): AnchoredMenuItem[] {
	const rows: AnchoredMenuItem[] = [];
	for (const item of items) {
		if (item.destructive && rows.length > 0) rows.push({ divider: true });
		rows.push(toAnchoredItem(item));
	}
	return rows;
}

/** The app holds the Collection-write grant either type-scoped to `List/v1`
 *  or wildcard (`entities.write:*`). */
function canWriteCollections(caps: readonly string[] | undefined): boolean {
	if (!caps) return false;
	return caps.includes(COLLECTIONS_WRITE_CAPABILITY) || caps.includes("entities.write:*");
}

/** Open the collection picker at `point`, re-opening itself after each
 *  toggle so the user can add to several Collections without re-navigating. */
async function openCollectionPicker(
	point: { x: number; y: number },
	collections: ObjectMenuCollections,
	entityId: string,
	chrome: ObjectMenuChromeLabels,
): Promise<void> {
	const options = await listCollectionsForObject(collections.service, entityId);
	if (options.length === 0) {
		openAnchoredMenu(point, [{ label: chrome.noCollections, onSelect: () => {}, disabled: true }], {
			menuLabel: chrome.collectionsRegion,
		});
		return;
	}
	const items: AnchoredMenuItem[] = options.map((opt) => ({
		label: opt.name,
		...(opt.isMember ? { icon: IconName.CheckCircle } : {}),
		onSelect: () => {
			void toggleCollectionMembership(
				collections.service,
				opt.id,
				entityId,
				!opt.isMember,
				collections.appId,
			).then(() => openCollectionPicker(point, collections, entityId, chrome));
		},
	}));
	openAnchoredMenu(point, items, { menuLabel: chrome.collectionsRegion });
}

function collectionExtraItem(
	point: { x: number; y: number },
	collections: ObjectMenuCollections,
	entityId: string,
	chrome: ObjectMenuChromeLabels,
): ObjectMenuExtraItem {
	return {
		id: ADD_TO_COLLECTION_ITEM_ID,
		label: chrome.addToCollection,
		icon: IconName.Folder,
		run: () => openCollectionPicker(point, collections, entityId, chrome),
	};
}

/** The curated verbs the object ⋯ menu surfaces as contributed actions
 *  (OQ-AS-1 — object + selection menus). `open` is excluded — it stays on the
 *  open-resolution path (the "Open with ▸" cascade above), never routed through
 *  the contributed-action surface. */
const OBJECT_MENU_CONTRIBUTED_VERBS: readonly ContributedVerb[] = [
	ContributedVerb.Process,
	ContributedVerb.Convert,
	ContributedVerb.Compose,
	ContributedVerb.Share,
	ContributedVerb.Export,
];

/** The shell `IconName` set, so a contributor-declared icon slug is only
 *  painted when it names a real glyph (a bogus name falls back to no icon
 *  rather than a broken render). Built once. */
const ICON_NAME_SET: ReadonlySet<string> = new Set<string>(Object.values(IconName));

function actionGroupLabel(group: ActionGroup, chrome: ObjectMenuChromeLabels): string {
	switch (group) {
		case ActionGroup.Share:
			return chrome.actionGroupShare;
		case ActionGroup.Convert:
			return chrome.actionGroupConvert;
		default:
			return chrome.actionGroupActions;
	}
}

/** Fetch the contributed actions for a target via the host runtime's
 *  `intents.suggestActions`. Read-only; resolves `[]` when the host doesn't
 *  expose the surface, the open is a self-targeting header ⋯ on the current
 *  object (we still surface actions — the suppression is only of the redundant
 *  *Open* item), or the lookup throws. The shell already relevance-gates +
 *  trust-tags; the menu only groups + caps + renders. */
async function suggestContributedActions(
	runtime: ObjectMenuRuntime,
	target: ObjectMenuTarget,
): Promise<ContributedAction[]> {
	const suggestActions = runtime?.services?.intents?.suggestActions;
	if (!suggestActions) return [];
	const actionTarget: { entityId?: string; entityType?: string } = { entityId: target.entityId };
	if (target.entityType) actionTarget.entityType = target.entityType;
	try {
		const actions = await suggestActions({
			target: actionTarget,
			verbs: OBJECT_MENU_CONTRIBUTED_VERBS,
		});
		return [...actions];
	} catch {
		return [];
	}
}

/** Render one contributed action as an anchored row: the (already shell-
 *  sanitized, attributed) label + its validated icon, dispatching `(verb, kind)`
 *  to the contributor on select. The host runs no contributor code — it only
 *  dispatches the intent (doc 63 §Security). */
function contributedActionRow(
	action: ContributedAction,
	runtime: ObjectMenuRuntime,
	target: ObjectMenuTarget,
): AnchoredMenuItem {
	const icon = action.icon && ICON_NAME_SET.has(action.icon) ? (action.icon as IconName) : undefined;
	return {
		label: action.label,
		...(icon ? { icon } : {}),
		onSelect: () => {
			const payload: Record<string, unknown> = { entityId: target.entityId };
			if (target.entityType) payload.entityType = target.entityType;
			if (action.kind) payload.kind = action.kind;
			payload.handlerAppId = action.appId;
			void runtime?.services?.intents?.dispatch?.({ verb: action.verb, payload });
		},
	};
}

/** Build the contributed-action rows that splice into the object menu: each
 *  group renders as a section header + its inline rows; everything else (group
 *  overflow + every sideloaded contribution) collapses into a single trailing
 *  "More actions…" submenu (doc 63 §Anti-rot — grouped, capped, More…). Returns
 *  `[]` when there are no contributions. */
function buildContributedRows(
	actions: readonly ContributedAction[],
	runtime: ObjectMenuRuntime,
	target: ObjectMenuTarget,
	chrome: ObjectMenuChromeLabels,
): AnchoredMenuItem[] {
	const groups: ContributedActionGroup[] = groupContributedActions(actions);
	if (groups.length === 0) return [];
	const rows: AnchoredMenuItem[] = [];
	const overflow: AnchoredMenuItem[] = [];
	for (const group of groups) {
		if (group.inline.length > 0) {
			rows.push({ section: true, label: actionGroupLabel(group.group, chrome) });
			for (const action of group.inline) rows.push(contributedActionRow(action, runtime, target));
		}
		for (const action of group.overflow) overflow.push(contributedActionRow(action, runtime, target));
	}
	if (overflow.length > 0) {
		// Lead the More-actions submenu with a divider so it reads as the
		// catch-all tail, not a sibling of the inline groups.
		if (rows.length > 0) rows.push({ divider: true });
		rows.push({
			label: chrome.moreContributedActions,
			icon: IconName.CaretRight,
			submenu: overflow,
		});
	}
	// A leading divider separates the whole contributed block from the
	// app's own built-ins / extras above it.
	return rows.length > 0 ? [{ divider: true }, ...rows] : [];
}

/** Ask the shell which apps can open the target (default first) so the menu
 *  can offer "Open with ▸" when there's a choice. Read-only; resolves `[]`
 *  when the host doesn't expose `intents.suggest`, the open is suppressed, or
 *  the lookup throws — the menu then shows the plain "Open" with no cascade. */
async function suggestOpenWith(
	runtime: ObjectMenuRuntime,
	target: ObjectMenuTarget,
): Promise<OpenWithEntry[]> {
	const suggest = runtime?.services?.intents?.suggest;
	if (!suggest) return [];
	const payload: Record<string, unknown> = { entityId: target.entityId };
	if (target.entityType) payload.entityType = target.entityType;
	try {
		const handlers = await suggest({ verb: OPEN_VERB, payload });
		return handlers.map((h) => ({ appId: h.appId, label: h.label ?? h.appId }));
	} catch {
		return [];
	}
}

/** Build + render the object menu at `point`. Async only because the pin
 *  state + open candidates are fetched first; the popup itself opens
 *  synchronously once resolved. Resolves when the menu is on screen. */
export async function openObjectMenu(
	point: { x: number; y: number },
	options: OpenObjectMenuOptions,
): Promise<void> {
	const chrome = resolveObjectMenuChromeLabels(options.labels);
	const [pinned, openWithCandidates, contributedActions] = await Promise.all([
		isObjectPinned(options.runtime, options.target.entityId),
		options.omitOpen
			? Promise.resolve<OpenWithEntry[]>([])
			: suggestOpenWith(options.runtime, options.target),
		// The action surface (doc 63 / AS-1): every object menu becomes
		// contribution-aware here with no per-app change — the same incremental
		// rollout the universal-icon / cover passes used.
		suggestContributedActions(options.runtime, options.target),
	]);

	// Splice the cross-app "Add to collection…" item (before Remove) when the
	// host injects the surface AND the app holds the type-scoped write grant.
	const extraItems = [...(options.extraItems ?? [])];
	if (options.collections && canWriteCollections(options.runtime?.capabilities)) {
		extraItems.push(collectionExtraItem(point, options.collections, options.target.entityId, chrome));
	}

	// Build the built-ins WITHOUT the destructive Remove row — the contributed
	// actions splice in after the built-ins / extras but before Remove (so
	// destructive stays last), each block fenced by a divider.
	const items = buildObjectMenuItems({
		target: options.target,
		runtime: options.runtime,
		pinned,
		labels: chrome,
		...(options.omitOpen ? { omitOpen: true } : {}),
		...(options.onShare ? { onShare: options.onShare } : {}),
		...(extraItems.length > 0 ? { extraItems } : {}),
		...(openWithCandidates.length > 0 ? { openWithCandidates } : {}),
	});

	const rows: AnchoredMenuItem[] = withSectionDividers(items);
	rows.push(...buildContributedRows(contributedActions, options.runtime, options.target, chrome));
	if (options.onRemove) {
		if (rows.length > 0) rows.push({ divider: true });
		rows.push({
			label: chrome.remove,
			icon: IconName.Trash,
			destructive: true,
			onSelect: () => {
				void options.onRemove?.();
			},
		});
	}

	openAnchoredMenu(point, rows, {
		menuLabel: chrome.menuRegion,
		...(options.anchor ? { anchor: options.anchor } : {}),
		// The object-menu ⋯ is a right-positioned overflow button by the
		// cross-app rule, so a button-anchored open right-aligns to its edge
		// unless the caller overrides.
		...(options.align ? { align: options.align } : options.anchor ? { align: MenuAlign.End } : {}),
	});
}

/** Close the open object menu (alias of the shared anchored-menu close so
 *  callers don't need to know it shares the singleton). */
export function closeObjectMenu(): void {
	closeAnchoredMenu();
}

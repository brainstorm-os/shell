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
	AppToolApprovalState,
	type AppToolRecord,
	AppToolSurface,
	type ContributedAction,
	type ContributedActionGroup,
	ContributedVerb,
	ToolCallInitiator,
	ToolFrictionDecision,
	appToolToContributedAction,
	decideAppToolFriction,
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
	/** Report the outcome of an app tool run from this menu (Tool-7). A host
	 *  that renders tool rows SHOULD supply one; without it a refusal surfaces
	 *  as an unhandled rejection rather than silence. */
	onToolResult?: ObjectMenuToolReporter;
	/** Ask a human to approve a tool whose declared effect requires it (today:
	 *  `external`). Without one, such tools are not offered at all rather than
	 *  offered and always refused. */
	onToolConfirm?: ObjectMenuToolConfirm;
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
const APP_TOOL_MENU_SURFACE: string = AppToolSurface.Menu;

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
/** Can THIS menu actually run the tool, with only a click to go on?
 *
 * `tools.list` already dropped tools the caller lacks the capability to call.
 * That is necessary and was not sufficient: a menu click carries no arguments
 * and no human approval, so two further classes would have rendered as enabled
 * rows that always fail —
 *
 *   - a tool with a REQUIRED input: `tools.call` refuses it `Invalid`
 *     ("missing required argument") every single time;
 *   - a tool whose effect asks for confirmation (`external`): refused
 *     `NeedsConfirm` unless a human approved it first.
 *
 * The second is recoverable — a host that can ask supplies `onToolConfirm`, and
 * then those tools ARE offered. The first needs an argument prompt, which is
 * `Tool-8`'s proposal tray; until then such tools are simply not menu rows.
 * Hiding beats a row that refuses on every click. */
function needsHumanAnswer(tool: AppToolRecord): boolean {
	// TWO independent reasons to ask, and both must be consulted. Deriving this
	// from `effect` alone was a real regression: Tool-5 makes an UNAPPROVED tool
	// refuse server-side, while the menu — seeing `pure` — sent no `confirmed`,
	// so the approval was never recorded and the row failed on every click,
	// forever.
	if ((tool.approval ?? AppToolApprovalState.New) !== AppToolApprovalState.Approved) return true;
	return (
		decideAppToolFriction(tool.effect, ToolCallInitiator.UserGesture) === ToolFrictionDecision.Confirm
	);
}

function menuCanInvoke(tool: AppToolRecord, canConfirm: boolean): boolean {
	if (tool.input.some((i) => i.required)) return false;
	return needsHumanAnswer(tool) ? canConfirm : true;
}

/** Menu-surfaced tools that apply to this object. Declared-type match only —
 *  `tools.list` never reads content — filtered server-side to what this caller
 *  may CALL, then filtered here to what a click alone can actually invoke. */
async function suggestAppTools(
	runtime: ObjectMenuRuntime,
	target: ObjectMenuTarget,
	canConfirm: boolean,
): Promise<AppToolRecord[]> {
	const list = runtime?.services?.appTools?.list;
	if (!list) return [];
	try {
		const input: { appliesTo?: string; surface?: string } = { surface: APP_TOOL_MENU_SURFACE };
		if (target.entityType) input.appliesTo = target.entityType;
		return [...(await list(input))].filter((tool) => menuCanInvoke(tool, canConfirm));
	} catch {
		return [];
	}
}

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
/** A tool row carries the provider's name IN THE LABEL.
 *
 * It was a `hint` first, which reads better — but `toContextItem` does not map
 * `hint` onto the shared menu runtime's item, so it rendered as nothing.
 * Attribution is not decoration here: `dedupeKey` deliberately keeps two apps'
 * same-titled tools as two rows, so without it the overflow can show two
 * byte-identical labels and the user cannot tell the trusted provider from the
 * sideloaded one.
 *
 * KNOWN RESIDUAL: a title may itself contain " — ", so a sideloaded app can
 * make its row READ like another provider's ("Export — Notes" becomes
 * "Export — Notes — Evil", and a narrow menu clips the true tail). Refusing the
 * separator in titles was tried and reverted — it rejects legitimate titles
 * (the repo's own example is "Rewrite — tone"), so the cure cost more than the
 * disease. The real fix is a menu item that can render attribution as a
 * separate muted element rather than as label text; until the shared item type
 * grows one, this is a visible-text spoof against a length-capped,
 * invisible-text-screened string, not a hidden one. */
function appToolRow(
	action: ContributedAction,
	tool: AppToolRecord,
	runtime: ObjectMenuRuntime,
	report: ObjectMenuToolReporter | undefined,
	confirm: ObjectMenuToolConfirm | undefined,
): AnchoredMenuItem {
	return {
		label: `${action.label} — ${action.appLabel}`,
		onSelect: () => runAppTool(runtime, tool, report, confirm),
	};
}

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
/** Run an app tool from a menu row.
 *
 * NOT fire-and-forget. The intent precedent (`contributedActionRow`) drops the
 * promise, which is tolerable for a dispatch that launches a visible app, and
 * NOT tolerable here: `tools.call` refuses with named errors (`Denied`,
 * `NeedsConfirm`, `Busy`, `TooLarge`, `Timeout`, `ProviderError`) and a
 * swallowed refusal is a menu row that silently does nothing — doc 57's "never
 * silent" rule, and the standing rule against a control that appears to work.
 *
 * The host decides how to show it: `onToolResult` is the reporting seam, and a
 * menu WITHOUT one renders no tool rows at all (see the fetch above), so the
 * `!report` rethrow below is a belt-and-braces path rather than the normal one. */
function runAppTool(
	runtime: ObjectMenuRuntime,
	tool: AppToolRecord,
	report: ObjectMenuToolReporter | undefined,
	confirm: ObjectMenuToolConfirm | undefined,
): void {
	const call = runtime?.services?.appTools?.call;
	if (!call) return;
	const needsConfirm = needsHumanAnswer(tool);
	void (async () => {
		try {
			// A confirm-requiring tool is only OFFERED when the host can ask, so
			// the approval is always a real human answer — never a flag this code
			// invents on the caller's behalf.
			// The REASON is passed through, so a host can ask "this changed since
			// you approved it" rather than showing the dialog it always shows —
			// otherwise the rug-pull signal is computed and thrown away before it
			// reaches a person.
			if (needsConfirm && !(await confirm?.(tool, approvalReason(tool)))) return;
			const result = await call({
				tool: tool.id,
				...(needsConfirm ? { confirmed: true } : {}),
			});
			report?.({ tool, ok: true, value: result.value });
		} catch (error: unknown) {
			const kind = error instanceof Error && error.name ? error.name : "Error";
			// Provider-authored text — the reporter renders it as DATA, never as
			// instructions (doc 78 §Security).
			const message = error instanceof Error ? error.message : String(error);
			if (!report) throw error;
			report({ tool, ok: false, kind, message });
		}
	})();
}

/** How a host reports the outcome of a tool run started from an object menu.
 *  A toast, an inline chip — the menu does not care, but it must not be
 *  nothing. */
/** Why the host is being asked. `Changed` is the rug-pull case and deserves
 *  different wording from a first-time approval. */
export type ObjectMenuToolConfirm = (
	tool: AppToolRecord,
	reason: AppToolApprovalState | ToolFrictionDecision.Confirm,
) => Promise<boolean>;

function approvalReason(tool: AppToolRecord): AppToolApprovalState | ToolFrictionDecision.Confirm {
	const state = tool.approval ?? AppToolApprovalState.New;
	return state === AppToolApprovalState.Approved ? ToolFrictionDecision.Confirm : state;
}

export type ObjectMenuToolReporter = (
	outcome:
		| { tool: AppToolRecord; ok: true; value: unknown }
		| { tool: AppToolRecord; ok: false; kind: string; message: string },
) => void;

function buildContributedRows(
	actions: readonly ContributedAction[],
	runtime: ObjectMenuRuntime,
	target: ObjectMenuTarget,
	chrome: ObjectMenuChromeLabels,
	toolsById: ReadonlyMap<string, AppToolRecord>,
	report?: ObjectMenuToolReporter,
	confirm?: ObjectMenuToolConfirm,
): AnchoredMenuItem[] {
	const groups: ContributedActionGroup[] = groupContributedActions(actions);
	if (groups.length === 0) return [];
	const rows: AnchoredMenuItem[] = [];
	const overflow: AnchoredMenuItem[] = [];
	for (const group of groups) {
		const row = (action: ContributedAction): AnchoredMenuItem => {
			const tool = toolsById.get(action.id);
			return tool
				? appToolRow(action, tool, runtime, report, confirm)
				: contributedActionRow(action, runtime, target);
		};
		if (group.inline.length > 0) {
			rows.push({ section: true, label: actionGroupLabel(group.group, chrome) });
			for (const action of group.inline) rows.push(row(action));
		}
		for (const action of group.overflow) overflow.push(row(action));
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
	const [pinned, openWithCandidates, contributedActions, appTools] = await Promise.all([
		isObjectPinned(options.runtime, options.target.entityId),
		options.omitOpen
			? Promise.resolve<OpenWithEntry[]>([])
			: suggestOpenWith(options.runtime, options.target),
		// The action surface (doc 63 / AS-1): every object menu becomes
		// contribution-aware here with no per-app change — the same incremental
		// rollout the universal-icon / cover passes used.
		suggestContributedActions(options.runtime, options.target),
		// Tool-7: menu-surfaced app tools, fetched in the SAME round trip so a
		// menu open still costs one wait, not two.
		// A host that cannot REPORT an outcome does not get tool rows. Every
		// refusal `tools.call` can produce would otherwise vanish into an
		// unhandled rejection, which is doc 57's "never silent" broken in the
		// quietest possible way — and today no caller passes the seam, so this
		// is not hypothetical.
		options.onToolResult
			? suggestAppTools(options.runtime, options.target, options.onToolConfirm !== undefined)
			: Promise.resolve<AppToolRecord[]>([]),
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
	// ONE contributed block: app tools are projected onto the shared
	// `ContributedAction` shape and grouped by the same AS-4 policy, so a
	// sideloaded tool is quarantined under "More app actions" and the inline cap
	// counts tools and intents together. Two parallel blocks would be exactly
	// the menu rot AS-4 exists to prevent.
	rows.push(
		...buildContributedRows(
			[...contributedActions, ...appTools.map(appToolToContributedAction)],
			options.runtime,
			options.target,
			chrome,
			new Map(appTools.map((tool) => [tool.id, tool])),
			options.onToolResult,
			options.onToolConfirm,
		),
	);
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

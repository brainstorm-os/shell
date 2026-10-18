/**
 * The one way an app asks the shell to open (or quick-look) an entity.
 *
 * Every first-party app was hand-rolling the same block —
 * `runtime?.services?.intents?.dispatch({ verb: "open", payload: { … } })`
 * — with subtly different shapes (`runtime.intents` vs
 * `runtime.services.intents`), inconsistent error handling, and a
 * client-supplied `source` the shell ignores anyway (the broker stamps
 * the calling app id from the envelope; a client `source` is not trusted).
 * Per §The Link component, every
 * internal navigation goes through one primitive. The four navigation
 * *modes* (`new-tab` / `new-window` / …), `ui.navigate`, and route-aware
 * focus-existing are a Stage 8 commitment per that doc's phasing — this is
 * the verb-dispatch core they will build on, not their replacement.
 */

/** The navigation verb the shell IntentsBus resolves to a registered opener.
 *  Centralised so the literal isn't re-typed across the open/suggest paths. */
export const OPEN_VERB = "open";

export type IntentDispatch = (intent: {
	verb: string;
	payload: Record<string, unknown>;
}) => unknown | Promise<unknown>;

/** Both runtime shapes seen in the wild: the SDK runtime exposes
 *  `services.intents.dispatch`; the thinner app-preload surface a couple
 *  of apps type exposes `intents.dispatch`. We accept either. */
export type OpenCapableRuntime =
	| {
			intents?: { dispatch?: IntentDispatch } | null;
			services?: { intents?: { dispatch?: IntentDispatch } | null } | null;
	  }
	| null
	| undefined;

/** What the shell does with a navigation result. Browser-identical: a plain
 *  click replaces in place; Cmd/Ctrl+click opens a new tab; Shift+click opens a
 *  new window; Alt+click opens it beside the current pane (doc 37 `new-panel`). The wire value is the string; the shell mirrors this enum in its
 *  navigation resolver. Per §Navigation modes. */
export enum NavigationMode {
	Replace = "replace",
	NewTab = "new-tab",
	NewWindow = "new-window",
	/** Split view (6.14, doc 37's `new-panel`): open beside the source pane in
	 *  the same window. */
	NewPanel = "new-panel",
}

/** Derive the navigation mode from a mouse/keyboard event's modifiers — the
 *  uniform mapping every `<Link>` / open call uses so modes feel identical
 *  across apps. Middle-click is a new tab (Chrome convention). */
export function navModeFromEvent(
	event:
		| {
				metaKey?: boolean;
				ctrlKey?: boolean;
				shiftKey?: boolean;
				altKey?: boolean;
				button?: number;
		  }
		| null
		| undefined,
): NavigationMode {
	if (!event) return NavigationMode.Replace;
	if (event.shiftKey) return NavigationMode.NewWindow;
	if (event.altKey) return NavigationMode.NewPanel;
	if (event.metaKey || event.ctrlKey || event.button === 1) return NavigationMode.NewTab;
	return NavigationMode.Replace;
}

export type OpenEntityTarget = {
	entityId: string;
	entityType?: string;
	/** How to place the result — replace (default) / new tab / new window. */
	mode?: NavigationMode;
	/** Force a specific opener app — the "Open with ▸ <app>" pick from the
	 *  shared object menu. When set, the shell routes to this exact handler
	 *  instead of the default pick (honoured only if the app actually claims
	 *  the target). Omit for the normal default-handler resolution. */
	handlerAppId?: string;
	/** Opt-in extra payload an originator attaches — e.g. Files passes a
	 *  folder `context` + `siblings` so Preview can build its gallery. The
	 *  `entityId` always wins over anything spread in here. */
	payload?: Record<string, unknown>;
};

function resolveDispatch(rt: OpenCapableRuntime): IntentDispatch | undefined {
	return rt?.services?.intents?.dispatch ?? rt?.intents?.dispatch ?? undefined;
}

async function dispatchVerb(
	rt: OpenCapableRuntime,
	verb: string,
	target: OpenEntityTarget,
): Promise<boolean> {
	const dispatch = resolveDispatch(rt);
	if (!dispatch || !target.entityId) return false;
	const payload: Record<string, unknown> = { ...target.payload, entityId: target.entityId };
	if (target.entityType !== undefined) payload.entityType = target.entityType;
	if (target.mode !== undefined) payload.navMode = target.mode;
	if (target.handlerAppId !== undefined) payload.handlerAppId = target.handlerAppId;
	try {
		await dispatch({ verb, payload });
		return true;
	} catch (error) {
		console.warn(`[sdk] intents.dispatch(${verb}) failed:`, error);
		return false;
	}
}

/** Dispatch `intent.open` for the entity. Resolves `true` when a
 *  dispatcher was present and didn't throw, `false` otherwise — callers
 *  use the `false` return to fall back (e.g. a standalone-dev toast). */
export function openEntity(rt: OpenCapableRuntime, target: OpenEntityTarget): Promise<boolean> {
	return dispatchVerb(rt, OPEN_VERB, target);
}

/** Dispatch `intent.quick-look` for the entity (same payload contract). */
export function quickLookEntity(
	rt: OpenCapableRuntime,
	target: OpenEntityTarget,
): Promise<boolean> {
	return dispatchVerb(rt, "quick-look", target);
}

/** 9.8.7 — `intent.move` payload contract per design 30 §intent.move. The
 *  Files app declares the receiver registration; any app can dispatch
 *  this to ask the file manager to move (or copy) one or more entities
 *  between Folders. `fromFolderId` is required for moves (so the
 *  receiver can splice both ends of the membership swap); a copy omits
 *  it because membership-add doesn't touch the source. */
export type MoveEntityTarget = {
	entityIds: readonly string[];
	toFolderId: string;
	fromFolderId?: string;
	/** Multi-membership add instead of remove-and-add. Default false. */
	copy?: boolean;
};

/** Dispatch `intent.move`. Returns `true` when the dispatcher was
 *  present and the call didn't throw, `false` otherwise. Cap hint
 *  `intents.dispatch:move` is stamped by the runtime proxy at the same
 *  layer as `:open` / `:quick-look`. */
export async function moveEntity(
	rt: OpenCapableRuntime,
	target: MoveEntityTarget,
): Promise<boolean> {
	const dispatch = resolveDispatch(rt);
	if (!dispatch) return false;
	if (target.entityIds.length === 0 || !target.toFolderId) return false;
	const payload: Record<string, unknown> = {
		entityIds: [...target.entityIds],
		toFolderId: target.toFolderId,
	};
	if (target.fromFolderId !== undefined) payload.fromFolderId = target.fromFolderId;
	if (target.copy) payload.copy = true;
	try {
		await dispatch({ verb: "move", payload });
		return true;
	} catch (error) {
		console.warn("[sdk] intents.dispatch(move) failed:", error);
		return false;
	}
}

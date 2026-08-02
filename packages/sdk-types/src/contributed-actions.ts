/**
 * The action surface — pure logic shared by the shell (which resolves
 * contributions from the registry) and the SDK host primitive (which renders
 * them). Per §Anti–menu-rot: relevance is
 * the shell's job (discriminator matching, OQ-AS-2); this module owns the
 * *restraint* — mapping a verb to its grouping bucket, deduping near-identical
 * rows, ranking, capping inline, and trust-tier quarantine.
 *
 * Kept dependency-free + framework-agnostic so it's testable in isolation and
 * usable from both the shell main process and an app renderer.
 */

/**
 * The curated verbs an app may *contribute* as a cross-app action surfaced in
 * another app's menus (per doc 63 §The model). `open` is excluded — it stays on
 * the open-resolution path (OQ-AS-1); never routed through this surface.
 */
export const ContributedVerb = {
	Process: "process",
	Convert: "convert",
	Compose: "compose",
	Share: "share",
	Export: "export",
	Insert: "insert",
} as const;
export type ContributedVerb = (typeof ContributedVerb)[keyof typeof ContributedVerb];

/**
 * The shell-defined grouping buckets a contributed action renders under (doc 63
 * §Anti-rot — grouped, not flat). An unknown declared group falls back to
 * `Actions`.
 */
export const ActionGroup = {
	/** `share` contributions — "Share to…". */
	Share: "share",
	/** `convert`/`export` contributions — "Convert / Export". */
	Convert: "convert",
	/** `process`/`compose`/`insert` — the catch-all "Actions" bucket. */
	Actions: "actions",
} as const;
export type ActionGroup = (typeof ActionGroup)[keyof typeof ActionGroup];

/**
 * The trust tier of a contributing app, derived from its install provenance
 * (doc 63 §Security — trust tier). First-party + catalog-signed rank inline;
 * sideloaded contributions are quarantined under "More actions…" until promoted
 * (OQ-AS-3).
 */
export const ActionTrustTier = {
	/** Bundled first-party app, or a catalog-signed (verified) app. Inline. */
	Trusted: "trusted",
	/** Sideloaded / unsigned / untrusted-signature. Quarantined under "More…". */
	Sideloaded: "sideloaded",
} as const;
export type ActionTrustTier = (typeof ActionTrustTier)[keyof typeof ActionTrustTier];

/**
 * One ready-to-render contributed action, resolved by the shell's
 * `intents.suggestActions` pass. The host renders `label`/`icon` (shell-
 * sanitized, never raw contributor markup) and, on activation, dispatches the
 * `(verb, kind)` to the contributor via the fail-closed intents bus — it never
 * runs contributor code (doc 63 §Security — display in host, dispatch in
 * contributor). `appId`/`appLabel` attribute the action to its source app.
 */
export type ContributedAction = {
	/** Stable id for host keying / dedupe (`<verb>:<kind>:<appId>`). */
	id: string;
	verb: ContributedVerb;
	/** Sub-selector within the verb (e.g. `generate-image`); empty when none. */
	kind?: string;
	/** Host-rendered label — already resolved to a display string. */
	label: string;
	/** Shell `IconName` string the host paints (validated; never raw markup). */
	icon?: string;
	group: ActionGroup;
	priority: "primary" | "secondary";
	trustTier: ActionTrustTier;
	/** The contributing app's id (the dispatch target). */
	appId: string;
	/** The contributing app's display name, for "<label> — <app>" attribution. */
	appLabel: string;
	/** Identity for deduping, when `(verb, kind)` is not it. Set by contributions
	 *  that are individually addressable in their own right (app tools); absent
	 *  for intent-derived ones. */
	dedupeKey?: string;
};

/** The discriminators a contributed-action lookup matches against (doc 63
 *  §Anti-rot — relevance-gated; OQ-AS-2: discriminators only in v1). At least
 *  one should be set or the lookup matches every wildcard contribution. */
export type ContributedActionTarget = {
	entityId?: string;
	entityType?: string;
	mime?: string;
	format?: string;
};

/**
 * The verb → grouping-bucket map (doc 63 §Anti-rot — `Share to…` /
 * `Convert / Export` / `Actions`). Centralised so the bucket a verb lands in is
 * decided in exactly one place. An unknown verb falls back to `Actions`.
 */
export function groupForVerb(verb: string): ActionGroup {
	switch (verb) {
		case ContributedVerb.Share:
			return ActionGroup.Share;
		case ContributedVerb.Convert:
		case ContributedVerb.Export:
			return ActionGroup.Convert;
		default:
			return ActionGroup.Actions;
	}
}

/**
 * Render order of the buckets (doc 63 §Where contributed actions appear):
 * Share first, then Convert/Export, then the catch-all Actions group. A stable
 * order so an object's menu reads the same every time.
 */
export const ACTION_GROUP_ORDER: readonly ActionGroup[] = [
	ActionGroup.Share,
	ActionGroup.Convert,
	ActionGroup.Actions,
];

/** Inline cap per group before the rest collapse under "More actions…"
 *  (OQ-AS-4 — a small cap keeps the median object's menu short). */
export const INLINE_ACTIONS_PER_GROUP = 3;

/** A group of contributed actions ready to render — the bucket id plus its
 *  ranked rows already split into the inline head and the overflow tail. */
export type ContributedActionGroup = {
	group: ActionGroup;
	/** Up to {@link INLINE_ACTIONS_PER_GROUP} trusted rows shown inline. */
	inline: ContributedAction[];
	/** Everything else — trusted overflow + every sideloaded row — shown under
	 *  the shared "More actions…" affordance until promoted. */
	overflow: ContributedAction[];
};

/** Rank within a group: primary before secondary, trusted before sideloaded,
 *  then app id for a deterministic tiebreak (doc 63 §Anti-rot — Ranked). */
function rankAction(a: ContributedAction, b: ContributedAction): number {
	const pa = a.priority === "primary" ? 0 : 1;
	const pb = b.priority === "primary" ? 0 : 1;
	if (pa !== pb) return pa - pb;
	const ta = a.trustTier === ActionTrustTier.Trusted ? 0 : 1;
	const tb = b.trustTier === ActionTrustTier.Trusted ? 0 : 1;
	if (ta !== tb) return ta - tb;
	return a.appId.localeCompare(b.appId);
}

/**
 * Dedupe two apps registering the same `(verb, kind)` down to one labelled
 * choice (doc 63 §Anti-rot — Deduped). The higher-ranked contribution wins the
 * slot; the loser is dropped (it would be a near-identical row). Order-stable
 * for everything that survives.
 */
function dedupe(actions: readonly ContributedAction[]): ContributedAction[] {
	const byKey = new Map<string, ContributedAction>();
	for (const action of actions) {
		// `dedupeKey` overrides the `(verb, kind)` identity for contributions that
		// are ALREADY individually addressable. An app tool is exactly that — its
		// id is `app.<appId>.<name>` — and collapsing two apps' tools together is
		// the verb collision the app-tools track exists to remove (doc 78: today
		// the loop addresses a tool by its verb alone, so two tools collide).
		// Intent-derived contributions keep the original key, where dedupe is the
		// point: two apps registering `share` really are one labelled choice.
		const key = action.dedupeKey ?? `${action.verb}:${action.kind ?? ""}`;
		const existing = byKey.get(key);
		if (!existing || rankAction(action, existing) < 0) byKey.set(key, action);
	}
	return [...byKey.values()];
}

/**
 * Group, dedupe, rank, trust-quarantine and inline-cap a flat list of resolved
 * contributions into ordered, render-ready buckets (the whole §Anti-rot
 * policy). A sideloaded contribution is NEVER inline — it always lands in the
 * group's overflow tail (OQ-AS-3), so a sideloaded app can't plant an action
 * high in every menu before the user promotes it.
 */
export function groupContributedActions(
	actions: readonly ContributedAction[],
): ContributedActionGroup[] {
	const deduped = dedupe(actions);
	const buckets = new Map<ActionGroup, ContributedAction[]>();
	for (const action of deduped) {
		const list = buckets.get(action.group) ?? [];
		list.push(action);
		buckets.set(action.group, list);
	}

	const result: ContributedActionGroup[] = [];
	for (const group of ACTION_GROUP_ORDER) {
		const rows = buckets.get(group);
		if (!rows || rows.length === 0) continue;
		rows.sort(rankAction);
		const inline: ContributedAction[] = [];
		const overflow: ContributedAction[] = [];
		for (const row of rows) {
			// Trust quarantine: sideloaded rows are never inline. A trusted row
			// is inline until the group's cap fills.
			if (row.trustTier === ActionTrustTier.Trusted && inline.length < INLINE_ACTIONS_PER_GROUP) {
				inline.push(row);
			} else {
				overflow.push(row);
			}
		}
		result.push({ group, inline, overflow });
	}
	return result;
}

/** Build the stable contribution id used for host keying + dedupe. */
export function contributedActionId(verb: string, kind: string | undefined, appId: string): string {
	return `${verb}:${kind ?? ""}:${appId}`;
}

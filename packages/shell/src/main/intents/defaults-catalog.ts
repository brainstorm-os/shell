/**
 * Pure builder for the Settings → Defaults catalog: for each known entity
 * type / scheme / extension, which apps can `open` it and which one the
 * user has pinned as the default (the override the IntentsBus reads,
 * doc 37 §Default handlers + OpenRes-1c §Settings → Defaults extended
 * to scheme/extension).
 *
 * Kept framework- and repo-free so the union/sort/merge logic is unit-
 * tested without SQLite; the IPC handler feeds it the repo-derived inputs.
 *
 * Three sections (scheme, extension, entity type) ride the **same**
 * dashboard `defaultHandlers` map keyed by the IntentsBus signature
 * (`open:scheme:https` / `open:ext:pdf` / `open:io.brainstorm.notes/Note/v1`),
 * which lets the bus's existing `resolveDefaultHandler(verb, signature)`
 * lookup work without any schema change. Scheme + extension entries
 * also offer an **OS** pick alongside the in-vault apps so the user can
 * pin "always open `https:` in my browser" — different from the per-
 * scheme `osHandoffConsent` allow/deny (that one's the prompt's
 * memory; this one's the explicit user choice).
 */

import { isPlumbingEntityType, typeDisplayName } from "@brainstorm-os/sdk/system-entities";
import {
	OS_HANDOFF_APP_ID,
	OS_HANDOFF_APP_LABEL,
	OsHandoffSignatureKind,
	osHandoffSignature,
} from "@brainstorm-os/sdk-types";
import { defaultHandlerKey } from "../dashboard/dashboard-store";

/** The verb the Settings → Defaults surface configures. `open` is the one
 *  that answers "which app does this object open in"; `quick-look` stays
 *  Preview-owned and isn't user-configurable in v1. Centralised so the
 *  literal isn't re-typed (per CLAUDE.md — no raw discriminators). */
export const DEFAULT_HANDLER_VERB = "open";

/** The default editor an object opens in when no app specifically claims
 *  its type (per the universal-body design — every object has a rich-text
 *  body; apps are workflows over one shared object space). One source of
 *  truth: the IntentsBus uses it as the generic fallback, the Settings →
 *  Defaults catalog always offers it as a pick. */
export const GENERIC_OBJECT_EDITOR_APP_ID = "io.brainstorm.notes";

export type DefaultsCatalogApp = { appId: string; label: string };

export type DefaultsCatalogEntry = {
	entityType: string;
	/** Human caption for the type (`brainstorm/Note/v1` → `Note`) — F-414.
	 *  The wire id stays on `entityType` for pins / tooltips / dev views. */
	label: string;
	/** Capable open handlers ∪ the generic editor, deduped, label-sorted. */
	apps: DefaultsCatalogApp[];
	/** The user's pinned default for this type, or `null` (built-in pick). */
	defaultAppId: string | null;
};

/** Sentinel app id used for "Open with the operating system" — the
 *  canonical source moved to `@brainstorm-os/sdk-types` (the open-resolution
 *  contract owns the identity since the IntentsBus reads it on every
 *  external `open`). Re-exported here for backward-compat with code that
 *  imports it from the defaults catalog. */
export { OS_HANDOFF_APP_ID };

/** What kind of target a defaults-catalog row represents. The IntentsBus's
 *  `resolveDefaultHandler(verb, signature)` lookup happens against the
 *  same dashboard map for all three kinds — the `signature` is the
 *  discriminating string. Enum (not raw union) per the project convention. */
export enum DefaultsTargetKind {
	EntityType = "entityType",
	Scheme = "scheme",
	Extension = "extension",
}

export type DefaultsSchemeEntry = {
	scheme: string;
	/** Capable in-vault handlers + the OS-handoff option, deduped + sorted
	 *  (OS pinned last so it reads as the "fallback" choice). */
	apps: DefaultsCatalogApp[];
	/** Current pin (app id, the OS-handoff sentinel, or `null` for the
	 *  built-in pick). */
	defaultAppId: string | null;
};

export type DefaultsExtensionEntry = {
	extension: string;
	apps: DefaultsCatalogApp[];
	defaultAppId: string | null;
};

export type DefaultsCatalog = {
	verb: string;
	entries: DefaultsCatalogEntry[];
	/** Scheme-targeting defaults (OpenRes-1c slice 2). Empty when no app
	 *  has registered a `targetKind: scheme` opener yet — the renderer
	 *  collapses the section. */
	schemes: DefaultsSchemeEntry[];
	/** Extension-targeting defaults (OpenRes-1c slice 2). */
	extensions: DefaultsExtensionEntry[];
};

/** Human label the renderer shows for the OS-handoff pick. Canonical
 *  source in `@brainstorm-os/sdk-types`; re-exported for backward-compat. */
export { OS_HANDOFF_APP_LABEL };

export type BuildDefaultsCatalogInput = {
	/** Every registered entity type id (orphaned included). */
	entityTypes: readonly string[];
	/** App ids that registered an `open` opener/intent for the type. */
	capableApps: (entityType: string) => readonly string[];
	/** Human label for an app id (manifest name, falls back to the id). */
	appLabel: (appId: string) => string;
	/** The universal-body fallback editor — always offered so the user can
	 *  pin "open everything in Notes" even for types no app claims. `null`
	 *  when not configured (keeps the builder pure for tests). */
	genericEditorAppId: string | null;
	/** Current overrides keyed `"<verb>:<signature>"` (dashboard snapshot).
	 *  The `signature` is the entity-type id (entityType rows), or the
	 *  IntentsBus `osHandoffSignature` for scheme/ext rows. Both ride the
	 *  same map (`defaultHandlers`) so the bus's lookup is unified. */
	currentDefaults: Readonly<Record<string, string>>;
	/** Distinct scheme strings (e.g. `https`, `mailto`) every app has
	 *  registered an `open` opener for. Empty array when none registered;
	 *  the builder will emit `schemes: []`. */
	schemes?: readonly string[];
	/** Distinct extension strings (e.g. `pdf`, `csv`). Empty array when
	 *  none registered. */
	extensions?: readonly string[];
	/** App ids that registered a `scheme:<scheme>` opener (excludes the
	 *  OS-handoff sentinel — the builder injects that). */
	capableAppsForScheme?: (scheme: string) => readonly string[];
	/** App ids that registered an `extension:<ext>` opener. */
	capableAppsForExtension?: (extension: string) => readonly string[];
};

export function buildDefaultsCatalog(input: BuildDefaultsCatalogInput): DefaultsCatalog {
	// F-414: Settings → Default apps is a *user* surface. Drop plumbing types
	// the product writes (BrowsingSession, WorkflowRun, …) and types no app
	// actually claims as an opener — those only appeared because every type
	// inherited the generic Notes editor. Wire ids stay on `entityType` for
	// pins; the human caption is `label`.
	const entries = [...input.entityTypes]
		.filter((entityType) => !isPlumbingEntityType(entityType))
		.filter((entityType) => input.capableApps(entityType).length > 0)
		.map<DefaultsCatalogEntry>((entityType) => {
			const appIds = new Set<string>(input.capableApps(entityType));
			if (input.genericEditorAppId) appIds.add(input.genericEditorAppId);
			const apps = [...appIds]
				.map((appId) => ({ appId, label: input.appLabel(appId) }))
				.sort((a, b) => a.label.localeCompare(b.label) || a.appId.localeCompare(b.appId));
			const pinned = input.currentDefaults[defaultHandlerKey(DEFAULT_HANDLER_VERB, entityType)];
			return {
				entityType,
				label: typeDisplayName(entityType),
				apps,
				defaultAppId: pinned ?? null,
			};
		})
		.sort(
			(a, b) => a.label.localeCompare(b.label) || a.entityType.localeCompare(b.entityType),
		);

	const schemes = [...(input.schemes ?? [])]
		.sort((a, b) => a.localeCompare(b))
		.map<DefaultsSchemeEntry>((scheme) => {
			const entry = buildSignatureEntry(
				scheme,
				OsHandoffSignatureKind.Scheme,
				input.capableAppsForScheme,
				input,
			);
			return { scheme, apps: entry.apps, defaultAppId: entry.defaultAppId };
		});

	const extensions = [...(input.extensions ?? [])]
		.sort((a, b) => a.localeCompare(b))
		.map<DefaultsExtensionEntry>((extension) => {
			const entry = buildSignatureEntry(
				extension,
				OsHandoffSignatureKind.Ext,
				input.capableAppsForExtension,
				input,
			);
			return { extension, apps: entry.apps, defaultAppId: entry.defaultAppId };
		});

	return { verb: DEFAULT_HANDLER_VERB, entries, schemes, extensions };
}

/** Pure helper — shared scheme + extension entry builder. Same shape:
 *  capable apps ∪ OS-handoff sentinel, label-sorted, OS pinned LAST so
 *  the "Open with system default" option doesn't shuffle into the
 *  middle of the user's app list and is easy to grep visually. The
 *  signature feeds the dashboard map key so the bus reads the same
 *  pin via `resolveDefaultHandler(verb, signature)`. */
function buildSignatureEntry(
	target: string,
	kind: OsHandoffSignatureKind,
	capable: ((target: string) => readonly string[]) | undefined,
	input: BuildDefaultsCatalogInput,
): { target: string; apps: DefaultsCatalogApp[]; defaultAppId: string | null } {
	const appIds = new Set<string>(capable?.(target) ?? []);
	const apps = [...appIds]
		.map((appId) => ({ appId, label: input.appLabel(appId) }))
		.sort((a, b) => a.label.localeCompare(b.label) || a.appId.localeCompare(b.appId));
	apps.push({ appId: OS_HANDOFF_APP_ID, label: OS_HANDOFF_APP_LABEL });
	const signature = osHandoffSignature(kind, target);
	const pinned = input.currentDefaults[defaultHandlerKey(DEFAULT_HANDLER_VERB, signature)];
	return { target, apps, defaultAppId: pinned ?? null };
}

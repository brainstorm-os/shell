/**
 * Vault-entity index — a render-time lookup of an entity's display title
 * + own universal icon by id, so editor surfaces that persist only an id
 * (`@`-mention chips, page-refs, transclusion / block-embed cards) can
 * still paint the entity's live title + icon, and the Link property cell
 * can resolve N rows from one full-vault snapshot instead of N scans.
 *
 * Decoupled from any app runtime: the data source (`vaultEntities.list`
 * + `.onChange`) is INJECTED via `setEntityIndexSource`, which the host
 * app calls once at boot. The package never imports `window.brainstorm`.
 * With no source wired, every lookup is empty and subscribers simply
 * never fire — surfaces degrade to their id/Untitled fallbacks rather
 * than throwing.
 *
 * Module-level singleton (one snapshot shared by the whole app): the
 * first subscriber triggers a `list()` fetch + an `onChange`
 * subscription; every later vault write bumps a tick and re-fetches, so
 * a chip whose entity loads / is renamed / re-iconed after it mounted
 * re-renders. No polling — the staleness signal is the source's own
 * `onChange`. (Merged from Notes' former `entity-title-index` +
 * `entity-icon-index`; one fetch now feeds both maps.)
 */

import {
	type Icon,
	IconKind,
	type VaultEntity,
	defaultIconForType,
} from "@brainstorm-os/sdk-types";
import { parseIcon } from "@brainstorm-os/sdk/entity-icon";

/** Coerce a raw `properties.icon` value into an `Icon`. Mirrors the SDK's
 *  `parseIcon` (incl. its cross-app image-egress guard) but additionally
 *  accepts a bare emoji string — the legacy shape some entities still
 *  carry — so a string-iconed entity keeps its chip glyph. */
function coerceIcon(raw: unknown): Icon | null {
	if (typeof raw === "string" && raw.length > 0) return { kind: IconKind.Emoji, value: raw };
	return parseIcon(raw);
}

export type EntityIndexSubscription = { unsubscribe: () => void };

export type EntityIndexSource = {
	list: () => Promise<{ entities: readonly VaultEntity[] }>;
	onChange: (listener: () => void) => EntityIndexSubscription;
};

let source: EntityIndexSource | null = null;
let titlesById = new Map<string, string>();
let iconsById = new Map<string, Icon | null>();
let entityList: readonly VaultEntity[] = [];
let tick = 0;
let started = false;
let unsubscribeSource: (() => void) | null = null;
const listeners = new Set<() => void>();

export function entityTitleOf(entity: VaultEntity): string {
	const p = entity.properties as { title?: unknown; name?: unknown };
	if (typeof p.title === "string" && p.title.length > 0) return p.title;
	if (typeof p.name === "string" && p.name.length > 0) return p.name;
	return entity.id;
}

function emit(): void {
	tick += 1;
	for (const listener of listeners) listener();
}

function refresh(): void {
	if (!source) return;
	void source
		.list()
		.then((snapshot) => {
			const nextTitles = new Map<string, string>();
			const nextIcons = new Map<string, Icon | null>();
			for (const entity of snapshot.entities) {
				nextTitles.set(entity.id, entityTitleOf(entity));
				nextIcons.set(entity.id, coerceIcon(entity.properties?.icon));
			}
			titlesById = nextTitles;
			iconsById = nextIcons;
			entityList = snapshot.entities;
			emit();
		})
		.catch((error) => {
			console.warn("[editor/entity-index] refresh failed:", error);
		});
}

function ensureStarted(): void {
	if (started) return;
	if (!source) return; // first subscriber will retry once a source is wired
	started = true;
	const sub = source.onChange(() => refresh());
	unsubscribeSource = () => sub.unsubscribe();
	refresh();
}

function stop(): void {
	if (unsubscribeSource) unsubscribeSource();
	unsubscribeSource = null;
	started = false;
}

function subscribe(listener: () => void): () => void {
	ensureStarted();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) stop();
	};
}

/** Wire the index to a host data source (e.g. the shell's
 *  `vaultEntities` service). Call once at app boot. Passing `null`
 *  detaches. Re-wiring with active subscribers restarts against the new
 *  source and refreshes. */
export function setEntityIndexSource(next: EntityIndexSource | null): void {
	source = next;
	if (listeners.size > 0) {
		stop();
		ensureStarted();
	}
}

export function subscribeEntityTitles(listener: () => void): () => void {
	return subscribe(listener);
}

export function subscribeEntityIcons(listener: () => void): () => void {
	return subscribe(listener);
}

export function entityTitlesSnapshot(): number {
	return tick;
}

export function entityIconsSnapshot(): number {
	return tick;
}

/** Resolve an entity's display title by id from the current snapshot.
 *  `undefined` when unknown (not yet loaded) OR when the entity has no
 *  title/name yet (`entityTitleOf` stores the bare id as its fallback,
 *  surfaced as `undefined` so callers render their own "Untitled"). */
export function getEntityTitle(entityId: string): string | undefined {
	const title = titlesById.get(entityId);
	return title === undefined || title === entityId ? undefined : title;
}

/** Resolve an entity's own universal icon by id. `null` when unknown
 *  (not yet loaded, or genuinely icon-less) — callers render a type
 *  fallback. */
export function getEntityIcon(entityId: string): Icon | null {
	return iconsById.get(entityId) ?? null;
}

/** Icon for an embed / transclusion *card* slot: the entity's own
 *  universal icon when set, else the type-derived default glyph. Unlike
 *  inline row renderers (which render nothing when icon-less, per
 *  `39-universal-icons`), a block card has a fixed-size dedicated icon
 *  box — leaving it blank paints an empty square that reads as broken.
 *  This mirrors the "type pill" surface, which `defaultIconForType` is
 *  the documented fallback for. */
export function getEntityDisplayIcon(entityId: string, entityType: string): Icon {
	return getEntityIcon(entityId) ?? defaultIconForType(entityType);
}

/** The full entity list from the last snapshot — the Link picker reads
 *  this instead of its own `list()` call. */
export function entitiesSnapshotList(): readonly VaultEntity[] {
	return entityList;
}

/** Fetch the live entity list straight from the source (a fresh
 *  `list()`), independent of whether the reactive index is subscribed —
 *  the on-demand caret typeaheads (mention / transclusion / block-embed /
 *  link-markup) call this when they open. Falls back to the cached
 *  snapshot when no source is wired. */
export async function fetchEntities(): Promise<readonly VaultEntity[]> {
	if (!source) return entityList;
	try {
		return (await source.list()).entities;
	} catch (error) {
		console.warn("[editor/entity-index] fetchEntities failed:", error);
		return entityList;
	}
}

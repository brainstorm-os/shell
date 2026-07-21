/**
 * `@brainstorm-os/sdk/find-replace` — the ONE in-document find & replace
 * model every text-capable app reuses (Notes / Code-editor / Journal),
 * per doc 59. The **payback for the OQ-185 virtualization trade**: find
 * operates on the editor *model*, never the DOM, so it is correct even
 * when the matching block isn't rendered.
 *
 * Same shape as `@brainstorm-os/sdk/nav-history` (B8): a *pure* controller
 * owns query / option / match-cursor state; a thin per-app
 * `TextSearchProvider` bridges it to that app's text model; a shared
 * `<FindBar>` (B9.1b) is identical everywhere. This file is the pure
 * heart — no React, no DOM (`createNavHistory` precedent), so the whole
 * state machine is unit-tested without a renderer.
 *
 * Loop-free contract (mirrors nav-history): the controller never mutates
 * the document. `replace`/`replaceAll` call the provider, which goes
 * through the editor's *own* commands (one transaction / one undo step —
 * doc 59 + the [07] "never mutate Yjs-bound state outside editor
 * commands" invariant); the controller only re-derives match state.
 */

import { registerShortcutSuppression } from "../shortcut/suppression";

/** Discriminator for the controller lifecycle — enum, not bare literals
 *  (no-string-discriminator convention). */
export enum FindStatus {
	/** Bar closed; no active search. */
	Idle = "idle",
	/** Open with an empty term — no search run yet. */
	Empty = "empty",
	/** Open, term present, search produced ≥1 match. */
	Matches = "matches",
	/** Open, term present, search produced 0 matches. */
	NoMatches = "no-matches",
}

export type FindOptions = {
	caseSensitive: boolean;
	wholeWord: boolean;
	/** v1 ships the toggle; regex matching itself is OQ-FR-1 (v2). The
	 *  controller carries the flag so the UI + persistence are stable;
	 *  providers may treat it as literal until OQ-FR-1 lands. */
	regex: boolean;
	/** Restrict matches to the provider's current selection range. */
	inSelection: boolean;
};

export const DEFAULT_FIND_OPTIONS: FindOptions = Object.freeze({
	caseSensitive: false,
	wholeWord: false,
	regex: false,
	inSelection: false,
});

/** OQ-FR-4 — max length of a selection the find bar will prefill from. A
 *  longer selection is almost certainly "search within this region", not a
 *  term, so providers return `null` and the bar opens with the prior term. */
export const FIND_SEED_MAX_LEN = 200;

export type FindQuery = { term: string; options: FindOptions };

/**
 * An opaque, model-addressed match handle. The controller never inspects
 * it — only counts/orders them and hands them back to the provider for
 * reveal/replace. Concretely a Lexical `{nodeKey,offset,length}` /
 * CodeMirror `{from,to}` / Journal `{entryId,charRange}` — never a DOM
 * range (doc 59, load-bearing from OQ-185).
 */
export type Match = unknown;

export type ModelRange = unknown;

export interface TextSearchProvider {
	/** Search over the MODEL (e.g. `EditorState`), not the DOM. */
	search(query: FindQuery): Match[];
	/** Scroll the match's block into the virtualization window, THEN set
	 *  the editor's model selection (the exact OQ-185 recipe). */
	revealMatch(match: Match): void;
	/** Replace one match via the editor's own command (collab-safe, one
	 *  undo step). */
	replaceMatch(match: Match, replacement: string): void;
	/** Replace every match in ONE transaction / ONE undo step; returns
	 *  the count replaced (doc 59: correctness + don't-thrash budget). */
	replaceAll(query: FindQuery, replacement: string): number;
	/** Current model selection, for the "in selection" scope; `null`
	 *  when there is no ranged selection. */
	readonly selectionRange: ModelRange | null;
	/** OQ-FR-4 — the term to prefill when the bar opens: the text of a
	 *  non-empty selection that lies within a single block, or `null`
	 *  (collapsed / cross-block / empty → open with the previous term).
	 *  Optional so a provider can opt out (the controller treats a missing
	 *  method as "no seed"). */
	seedTerm?(): string | null;
}

export type FindControllerState = {
	readonly open: boolean;
	readonly term: string;
	readonly options: FindOptions;
	readonly matchCount: number;
	/** 0-based index of the active match, or -1 when none. The UI shows
	 *  `activeIndex + 1` of `matchCount`. */
	readonly activeIndex: number;
	readonly status: FindStatus;
};

export type FindPersist = {
	/** localStorage key (per surface) — the nav-history persistence
	 *  pattern: last term + options survive a reload. */
	key: string;
	storage?: FindStorage;
};

export interface FindStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export type CreateFindControllerOptions = {
	persist?: FindPersist;
	storage?: FindStorage;
};

export interface FindController {
	getState(): FindControllerState;
	subscribe(listener: () => void): () => void;
	open(mode?: "find" | "find-replace"): void;
	close(): void;
	/** Cheap synchronous open-state probe so the global Escape binding
	 *  (`attachFindShortcuts`) can decline to swallow Escape when the bar
	 *  isn't actually open. Satisfies `FindShortcutTarget.isOpen`. */
	isOpen(): boolean;
	setTerm(term: string): void;
	setOptions(patch: Partial<FindOptions>): void;
	/** Step to the next match (wraps). No-op with 0 matches. */
	next(): void;
	previous(): void;
	/** Replace the active match, then advance to the next deterministically. */
	replace(replacement: string): void;
	/** Replace all current matches in one provider transaction. */
	replaceAll(replacement: string): number;
	/** The active match handle (for the host to reveal), or `null`. */
	activeMatch(): Match | null;
}

type Persisted = { term: string; options: FindOptions };

function memoryStorage(): FindStorage {
	const map = new Map<string, string>();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => {
			map.set(k, v);
		},
	};
}

function resolveStorage(opts: CreateFindControllerOptions): FindStorage | null {
	const explicit = opts.persist?.storage ?? opts.storage;
	if (explicit) return explicit;
	if (!opts.persist) return null;
	try {
		if (typeof localStorage !== "undefined") return localStorage;
	} catch {
		// localStorage can throw in sandboxed/Node contexts — fall back.
	}
	return memoryStorage();
}

function statusFor(open: boolean, term: string, count: number): FindStatus {
	if (!open) return FindStatus.Idle;
	if (term.length === 0) return FindStatus.Empty;
	return count > 0 ? FindStatus.Matches : FindStatus.NoMatches;
}

/**
 * Pure controller (mirrors `createNavHistory`). Search runs synchronously
 * here on `setTerm`/`setOptions`; the *debounce off the keystroke path*
 * (doc 59) is the FindBar's concern (B9.1b) — keeping this layer pure and
 * fully testable, exactly as nav-history keeps app-state application in
 * the host.
 */
export function createFindController(
	provider: TextSearchProvider,
	opts: CreateFindControllerOptions = {},
): FindController {
	const storage = resolveStorage(opts);
	const persistKey = opts.persist?.key ?? null;

	let open = false;
	let term = "";
	let options: FindOptions = { ...DEFAULT_FIND_OPTIONS };
	let matches: Match[] = [];
	let activeIndex = -1;
	const listeners = new Set<() => void>();

	// Convention: an open find bar hijacks single-key chords app-wide
	// (so the app's `t/d/w/m`-style chords don't fire while the user is
	// typing a search term). Registered on open, disposed on close — apps
	// that mint a fresh controller per editor instance (Notes' `useMemo`
	// keyed by editor) would otherwise leak a source per remount. Mirrors
	// fancy-menus' `isOpen` shape — at plan row 8.8 this same suppression
	// flows through `MenuProvider` and this registration retires.
	let unregisterSuppression: (() => void) | null = null;

	if (storage && persistKey) {
		try {
			const raw = storage.getItem(persistKey);
			if (raw) {
				const p = JSON.parse(raw) as Partial<Persisted>;
				if (typeof p.term === "string") term = p.term;
				if (p.options && typeof p.options === "object") {
					options = { ...DEFAULT_FIND_OPTIONS, ...p.options };
				}
			}
		} catch {
			// Corrupt/old persisted blob → ignore, start clean.
		}
	}

	const build = (): FindControllerState => ({
		open,
		term,
		options,
		matchCount: matches.length,
		activeIndex,
		status: statusFor(open, term, matches.length),
	});

	// Stable snapshot — `getState()` must return the SAME reference until
	// something actually changes, or `useSyncExternalStore`'s `Object.is`
	// check sees a new object every render and loops forever (the
	// `nav-history` `get()` precedent — its `<NavButtons>` relies on the
	// exact same invariant). Rebuilt only when an emitting mutation runs.
	let snapshot: FindControllerState = build();

	const emit = (): void => {
		snapshot = build();
		for (const l of listeners) l();
	};

	const persist = (): void => {
		if (!storage || !persistKey) return;
		try {
			storage.setItem(persistKey, JSON.stringify({ term, options } satisfies Persisted));
		} catch {
			// Best-effort — never let persistence break find.
		}
	};

	const runSearch = (): void => {
		if (!open || term.length === 0) {
			matches = [];
			activeIndex = -1;
			return;
		}
		matches = provider.search({ term, options });
		activeIndex = matches.length > 0 ? 0 : -1;
	};

	const getState = (): FindControllerState => snapshot;

	const reveal = (): void => {
		const m = activeIndex >= 0 ? matches[activeIndex] : undefined;
		if (m !== undefined) provider.revealMatch(m);
	};

	return {
		getState,
		isOpen() {
			return open;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		open() {
			if (!open) {
				open = true;
				if (!unregisterSuppression) {
					unregisterSuppression = registerShortcutSuppression(() => open);
				}
				// OQ-FR-4 — prefill from a non-empty single-block selection
				// (editor-classic: select a word, ⌘F finds it). The provider
				// decides what counts as a seedable selection; a `null` seed
				// leaves the persisted/previous term in place.
				const seed = provider.seedTerm?.();
				if (seed && seed !== term) {
					term = seed;
					persist();
				}
				runSearch();
				if (matches.length > 0) reveal();
				emit();
			}
		},
		close() {
			if (open) {
				open = false;
				if (unregisterSuppression) {
					unregisterSuppression();
					unregisterSuppression = null;
				}
				matches = [];
				activeIndex = -1;
				emit();
			}
		},
		setTerm(next) {
			if (next === term) return;
			term = next;
			persist();
			runSearch();
			if (matches.length > 0) reveal();
			emit();
		},
		setOptions(patch) {
			options = { ...options, ...patch };
			persist();
			runSearch();
			if (matches.length > 0) reveal();
			emit();
		},
		next() {
			if (matches.length === 0) return;
			activeIndex = (activeIndex + 1) % matches.length;
			reveal();
			emit();
		},
		previous() {
			if (matches.length === 0) return;
			activeIndex = (activeIndex - 1 + matches.length) % matches.length;
			reveal();
			emit();
		},
		replace(replacement) {
			if (activeIndex < 0) return;
			const m = matches[activeIndex];
			if (m === undefined) return;
			provider.replaceMatch(m, replacement);
			// Re-derive matches post-edit; keep the cursor on the same
			// ordinal so the user marches forward deterministically (doc 59
			// "active match sticky across edits"). Clamp to the new count.
			const prev = activeIndex;
			matches = term.length > 0 ? provider.search({ term, options }) : [];
			activeIndex = matches.length === 0 ? -1 : Math.min(prev, matches.length - 1);
			if (activeIndex >= 0) reveal();
			emit();
		},
		replaceAll(replacement) {
			if (term.length === 0) return 0;
			const n = provider.replaceAll({ term, options }, replacement);
			matches = provider.search({ term, options });
			activeIndex = matches.length > 0 ? 0 : -1;
			emit();
			return n;
		},
		activeMatch() {
			return activeIndex >= 0 ? (matches[activeIndex] ?? null) : null;
		},
	};
}

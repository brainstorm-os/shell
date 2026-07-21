/**
 * 9.3.5.N4 — one-shot, vault-open body migration. Walks every loaded
 * note once on boot, plants any pre-N2 `SerializedEditorState` payload
 * into the universal-body Y.Doc root (the well-known `Y.XmlText` named
 * `"root"`), and writes a length-capped plain-text snippet onto
 * `StoredNote.body` for cold-cache rows the user has never opened since
 * the N2 transport swap.
 *
 * Three invariants — pinned by the test suite, not the comments:
 *
 *   - **Idempotent.** A vault-level stamp (`notes:migrationVersion` in
 *     the per-app `storage.kv`) records that the current
 *     `CURRENT_MIGRATION_VERSION` has run on this vault. Re-runs read
 *     the stamp first; a stamped vault skips the scan entirely (the
 *     load-bearing perf property — every Notes boot calls this, the
 *     hot path is one storage.get).
 *
 *   - **Reversible by snapshot.** Before mutating any note's `body`,
 *     the pre-migration legacy blob (a `SerializedEditorState` or a
 *     freeform legacy string) is preserved verbatim under
 *     `StoredNote.bodyLegacy`. To roll back: copy `bodyLegacy` back into
 *     `body`, delete `bodyLegacy`, and clear the vault stamp via the
 *     `storage.delete(MIGRATION_VERSION_KEY)`. The `bodyLegacy` field is
 *     tagged for purge in the v1.0 vault-format freeze (plan iteration
 *     10.8) — until then it is the recovery escape-hatch.
 *
 *   - **Non-destructive of new content.** Each per-note plant first
 *     checks the doc's universal body is empty
 *     (`getUniversalBody(doc).length === 0`); a non-empty doc means the
 *     user (or a sync replica) has already written content on the new
 *     path. In that case the migration does NOT touch the doc — it only
 *     refreshes the snippet, never clobbers live content.
 *
 * Plant mechanism: an ephemeral headless Lexical editor is created with
 * the full Notes node set, the legacy `SerializedEditorState` is parsed
 * via `editor.parseEditorState`, bound to the entity's Y.Doc through
 * `@lexical/yjs`'s `createBinding` + a local provider, then
 * `editor.setEditorState(parsed)` flushes through
 * `syncLexicalUpdateToYjs` inside a single `doc.transact` so the entire
 * plant is one Yjs transaction (one undo step, one update message). The
 * editor and binding are disposed immediately afterwards — no React, no
 * DOM, no observable cost beyond the parse + plant.
 *
 * Boot integration: `useNotes` awaits this migration before
 * `setReady(true)` on first run. The fast-path (stamped vault) costs one
 * `storage.get`. A slow first-run on a large vault is acceptable per the
 * spec — better than splitting first paint between migrated + legacy
 * rows. Per-note failures are caught + logged; one bad note never takes
 * down the vault.
 */

import {
	BASELINE_NODES,
	plantSerializedStateIntoDoc as plantViaSharedHelper,
} from "@brainstorm-os/editor";
import { getUniversalBody, isUniversalBodyEmpty } from "@brainstorm-os/react-yjs";
import type { Klass, LexicalNode, SerializedEditorState } from "lexical";
import type { Doc, XmlText } from "yjs";
import { migrateTitleIntoBody } from "../editor/migrate-title";
import { NOTES_ADDITIONAL_NODES } from "../editor/notes-nodes";
import { bodyToSnippet } from "../logic/body-to-snippet";
import type { StoredNote } from "./note";
import type { NotesRepository } from "./repository";
import type { StorageService } from "./runtime";

const MIGRATION_NODES: ReadonlyArray<Klass<LexicalNode>> = [
	...BASELINE_NODES,
	...NOTES_ADDITIONAL_NODES,
];

/** Per-app KV key (Notes is the sole consumer of `notes:`-prefixed keys
 *  in this app's storage scope) holding the most-recently-completed
 *  migration version. Present + equal to `CURRENT_MIGRATION_VERSION` →
 *  fast path. Missing or stale → full scan. The key is advisory perf,
 *  not a security gate: a corrupted / hand-edited / future-bumped stamp
 *  triggers a re-scan, which is safe because the per-note invariants
 *  (`docEmpty` check, `ClobberAvoided` outcome) guarantee no live content
 *  is overwritten regardless of stamp state. */
export const MIGRATION_VERSION_KEY = "notes:migrationVersion";

/** Bump this when the migration logic changes shape (a new field is
 *  carried, a new body category is normalised, etc.). A bump invalidates
 *  the stamp on existing vaults and forces a re-scan on next boot.
 *
 *  `2026-05-21-repair`: an earlier preload-side resolver shipped a
 *  structured-clone bug that aborted the per-note plant after the title
 *  was attached but before the body content synced. Vaults that booted
 *  against that build have `.ydoc` files holding the title + an empty
 *  paragraph and nothing else, while `bodyLegacy` still carries the
 *  intact legacy `SerializedEditorState`. The repair re-runs the
 *  migration, treating any doc with structural children but no inline
 *  text as effectively empty so it can be re-planted from
 *  `bodyLegacy`.
 *
 *  `2026-05-21-seeder-bodies`: the iteration seeder (`tools/mcp-server`)
 *  now produces rich-body iteration notes (status/timing card + plan
 *  narrative). The kv→entities backfill re-syncs the entities.db row to
 *  the new shape, but for the new body to actually reach the editor we
 *  also need the migration to replant the existing iteration / doc-docs
 *  Y.Docs from `bodyLegacy` — `ClobberAvoided` is the wrong default for
 *  rows the seeder owns end-to-end (kv is the authority, not the live
 *  doc). Bumping the version forces the scan, and the per-note logic
 *  treats seeder-owned ids (`doc-docs-*`, `iteration-*`) as "always
 *  replant from legacy". User-authored notes still take the
 *  ClobberAvoided branch — the carve-out is strictly id-scoped.
 *
 *  `2026-05-22-snippet-walker`: `bodyToSnippet` was using
 *  `Y.XmlText.toString()`, which on a Lexical-yjs-bound doc emits
 *  `[object Object]` for every block-embed Map / XmlElement marker.
 *  The corrupted snippet shipped to `entity.properties.body`, and
 *  Journal / sidebar / cold-cache search rendered the garbage back to
 *  the user. Bumping the version forces a re-scan so every existing
 *  vault recomputes its denormalised `body` snippet via the fixed
 *  recursive walker. */
export const CURRENT_MIGRATION_VERSION = "9.3.5.N4-2026-05-22-empty-scan-no-stamp" as const;

/** Id prefixes the `tools/mcp-server` seeder owns end-to-end — these rows
 *  are regenerated from source on every `seed-cli` run, so the legacy
 *  `bodyLegacy` blob (just written by the backfill from the freshly seeded
 *  kv) is the authoritative content. The migration replants seeder rows
 *  even when the Y.Doc is non-empty (clearing the existing root first),
 *  bypassing `ClobberAvoided` — which exists to protect user content, not
 *  stale seeded content the seeder is trying to refresh. User-authored
 *  notes use ids like `n_*` and never `doc-docs-*` / `iteration-*` /
 *  `article-*`, so the carve-out can never overwrite anything the user
 *  wrote.
 *
 *  Mirrors the seeder's authoritative-id prefix list — keep the two in
 *  lockstep. */
const SEEDER_ID_PREFIXES = ["doc-docs-", "iteration-", "article-"] as const;

export function isSeederOwnedNote(id: string): boolean {
	for (const prefix of SEEDER_ID_PREFIXES) {
		if (id.startsWith(prefix)) return true;
	}
	return false;
}

/** Per-note migration outcome. The orchestrator aggregates these for
 *  the diagnostic summary written to console + returned to the caller. */
export enum MigrationOutcome {
	/** Body already a snippet + no legacy + doc empty → nothing to do. */
	Skipped = "skipped",
	/** Legacy body parsed + planted into the (empty) doc; snippet
	 *  written; `bodyLegacy` preserved. */
	Planted = "planted",
	/** Doc had content but `body` was empty / null — wrote the snippet
	 *  only (cold-cache row never opened since N2). */
	SnippetOnly = "snippet-only",
	/** A non-empty doc was already present AND legacy body was on disk
	 *  too: never overwrite live content. Snippet refreshed from the
	 *  live doc; legacy preserved for inspection. */
	ClobberAvoided = "clobber-avoided",
	/** Plant attempt threw (unparseable JSON, missing node class, …).
	 *  Legacy preserved; body left as empty snippet. Logged. */
	Failed = "failed",
}

export type MigrationSummary = Readonly<{
	scanned: number;
	planted: number;
	snippetOnly: number;
	clobberAvoided: number;
	failed: number;
	skipped: number;
	/** True when the vault was already stamped at the current version
	 *  and the scan was skipped entirely. */
	fastPath: boolean;
}>;

/** Subset of the renderer-side resolver this module needs. Mirrors the
 *  `YDocHandle` shape from `@brainstorm-os/react-yjs` so the orchestrator
 *  can be tested with a fake that hands back any Y.Doc. */
export type MigrationDocHandle = {
	doc: Doc;
	release(): void;
};

export type MigrationResolver = (entityId: string) => MigrationDocHandle;

export type RunVaultBodyMigrationOptions = Readonly<{
	notes: Map<string, StoredNote>;
	repo: NotesRepository;
	resolve: MigrationResolver;
	/** Resolves once the resolver has applied the entity's canonical
	 *  snapshot to the replica. Load-bearing for clobber-safety: the
	 *  resolver's `load()` is async, so `resolve()` returns an empty
	 *  doc that hydrates later. Without awaiting, the migration's
	 *  `docEmpty` check would read the unhydrated replica and plant
	 *  legacy content on top of a doc that's about to receive canonical
	 *  content via `Y.applyUpdate(doc, snapshot, REMOTE_ORIGIN)` — a
	 *  silent corruption path. Optional only so older shells / the
	 *  preview drop (which expose `resolve` but not `whenLoaded`) still
	 *  work; when absent the migration treats the resolver as
	 *  synchronous (correct under those configurations). */
	whenLoaded?: (entityId: string) => Promise<void>;
	storage: Pick<StorageService, "get" | "put">;
	/** Override the orchestration version (tests bump this to force a
	 *  re-run without stomping the production constant). */
	version?: string;
	/** Per-note error sink. Defaults to `console.warn`; tests pass a spy. */
	onError?: (note: StoredNote, err: unknown) => void;
}>;

/** Run the full vault-open migration. Mutates entries in `notes` in
 *  place (so the caller's React state observation already sees the
 *  patched rows when it builds the next render) and persists every
 *  changed row through `repo.save`. Failures are best-effort + logged. */
export async function runVaultBodyMigration(
	opts: RunVaultBodyMigrationOptions,
): Promise<MigrationSummary> {
	const version = opts.version ?? CURRENT_MIGRATION_VERSION;
	const stamp = await readMigrationStamp(opts.storage);
	if (stamp === version) return fastPathSummary();

	const tally = {
		scanned: 0,
		planted: 0,
		snippetOnly: 0,
		clobberAvoided: 0,
		failed: 0,
		skipped: 0,
	};
	// Transient failures — Denied / Unavailable from the entities service.
	// These are environmental (cap-ledger race during dev-seeder reinstall,
	// no active vault yet) and clear up by themselves on the next boot.
	// Counted separately so the stamping decision below can distinguish
	// "the vault is broken, retry" from "this one note is malformed,
	// move on".
	let transientFailed = 0;

	const allNotes = Array.from(opts.notes.values());
	// Per-note work is independent (each touches its own doc + repo row) and
	// the async cost is dominated by `whenLoaded` — process in bounded chunks
	// so disk reads run in parallel without minting every doc handle at once.
	//
	// CHUNK is small + we yield to the task queue between chunks so user input
	// (scroll, click, type) lands BETWEEN bursts of `applyUpdate` instead of
	// queueing behind a 16-doc Yjs pass. Without the yield, scrolling Notes
	// during a fresh-seed migration hits ~200 ms p99 stalls (see
	// `tests/perf/specs/notes-sidebar-scroll.spec.ts` — wheel vs wheel-after-
	// settle); the yield drops that toward the ~17 ms post-settle baseline.
	const CHUNK = 2;
	for (let i = 0; i < allNotes.length; i += CHUNK) {
		const chunk = allNotes.slice(i, i + CHUNK);
		await Promise.all(
			chunk.map(async (note) => {
				tally.scanned += 1;
				try {
					const patch = await migrateOneNote(note, opts.resolve, opts.whenLoaded);
					if (!patch) {
						tally.skipped += 1;
						return;
					}
					applyPatchInPlace(note, patch.fields);
					// Body-only patch — the migration MUST NOT round-trip the
					// whole captured note: by the time we reach this row the
					// user may have edited its `values` / `title` / `icon` /
					// `updatedAt` (the captured `note` reference froze at
					// boot, so a full `save` would silently overwrite those
					// edits on disk). The repo seam merges only `body`
					// server-side. A patch with no body field is a no-op.
					if (patch.fields.body !== undefined) {
						await opts.repo.patchBody(note.id, patch.fields.body);
					}
					countOutcome(tally, patch.outcome);
				} catch (err) {
					tally.failed += 1;
					if (isTransientFailure(err)) transientFailed += 1;
					emitError(opts, note, err);
				}
			}),
		);
		await yieldToRenderer();
	}

	// Stamp the version when this run actually finished migration work
	// for every note the caller handed us. Two carve-outs that DO NOT stamp
	// (and therefore retry on the next boot / re-list):
	//
	// 1. Transient failures (`Denied` / `Unavailable`) — environmental, not
	//    per-note. The dev-seeder reinstall race revokes `entities.write`
	//    mid-migration; one boot stamps the failure as "done" and the
	//    bodyLegacy planting never reaches Y.Doc.
	//
	// 2. Empty scan (`scanned === 0`). The first boot of a new vault has
	//    no notes; if we stamp here, a later `dev:reseed-vault` populates
	//    495 notes into entities.db but the next launch's migration
	//    fast-paths past them — Y.Docs stay empty, the editor shows just
	//    the icon. The migration must be cheap on a noop boot anyway, so
	//    re-running until there's actual work to do is the right default.
	//
	// Per-note logical failures (malformed `bodyLegacy`, unknown node
	// types) still stamp — those are not retryable and the user recovers
	// manually via the rollback target.
	const shouldStamp = transientFailed === 0 && tally.scanned > 0;
	if (shouldStamp) {
		try {
			await opts.storage.put(MIGRATION_VERSION_KEY, version);
		} catch (err) {
			console.warn("[notes/migrate-body] stamp failed:", err);
		}
	} else if (transientFailed > 0) {
		console.warn(
			`[notes/migrate-body] ${transientFailed} of ${tally.scanned} notes hit transient failures (Denied/Unavailable) — not stamping version, will retry on next boot`,
		);
	}
	// Empty-scan path is silent: a brand-new vault hitting this every
	// boot until it has content is expected and shouldn't pollute the log.

	return Object.freeze({ ...tally, fastPath: false });
}

/** Hand the main thread back to the renderer between migration chunks so a
 *  user gesture (scroll, click, type) gets a frame to be processed instead
 *  of queueing behind the next `applyUpdate` burst. Prefers
 *  `requestIdleCallback` — it ONLY fires when the renderer is genuinely idle,
 *  so an active scroll naturally pauses migration until the gesture ends.
 *  Falls back to a one-frame `setTimeout` outside the browser (Vitest under
 *  jsdom, where requestIdleCallback is absent). The 200 ms idle-timeout
 *  caps how long migration can stall behind a continuous gesture — past
 *  that we make progress anyway so a long scroll session doesn't freeze
 *  migration indefinitely. */
function yieldToRenderer(): Promise<void> {
	return new Promise((resolve) => {
		const g = globalThis as unknown as {
			requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => unknown;
		};
		if (typeof g.requestIdleCallback === "function") {
			g.requestIdleCallback(() => resolve(), { timeout: 200 });
		} else {
			setTimeout(resolve, 16);
		}
	});
}

/** Recognise errors that should NOT be considered terminal — the entities
 *  service throws `Denied` (capability revoked / not yet granted) and
 *  `Unavailable` (no active vault session, worker not ready) when the
 *  environment is in flux. These resolve themselves on the next boot. */
function isTransientFailure(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err.name === "Denied" || err.name === "Unavailable") return true;
	// SDK round-trip occasionally re-wraps; match by message prefix as
	// the belt-and-braces fallback so a future error-shape change can't
	// silently re-introduce the stamp-on-cap-denial bug.
	return /\b(no entities\.(?:read|write)|capability ledger unavailable|no active vault)\b/.test(
		err.message,
	);
}

type PerNotePatch = {
	outcome: MigrationOutcome;
	fields: Partial<StoredNote>;
};

/** Decide what to do with one note. Pure-ish — only touches the resolved
 *  Y.Doc, no storage, no React. Always releases the doc handle.
 *
 *  Awaiting `whenLoaded` before reading `body.length` is load-bearing:
 *  the resolver's `load()` is async, so a doc that has canonical content
 *  on the wire reads as empty until the snapshot lands. Skipping the
 *  await would mis-classify hydrating docs as empty → plant legacy
 *  content on top → collision when `Y.applyUpdate(REMOTE_ORIGIN)` fires.
 *  Tests with synchronous fakes never see this; production does. */
/** Per-note `whenLoaded` ceiling. A migration scan over a freshly-seeded
 *  vault (hundreds of `doc-docs-*` + `iteration-*` rows) issues
 *  `entities.loadDoc` IPCs in CHUNK-sized parallel bursts; IPC
 *  backpressure can drop the oldest waiters, leaving `whenLoaded`
 *  unresolved forever and stalling the migration's `Promise.all`.
 *  10 seconds is well past a healthy doc-load round-trip even on a cold
 *  cache + slow disk, so a timeout firing here always means a dropped /
 *  lost IPC, not a slow one. We then continue best-effort: read whatever
 *  the replica has and proceed as if `whenLoaded` resolved. */
const WHEN_LOADED_TIMEOUT_MS = 10_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race<T | undefined>([
			p,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function migrateOneNote(
	note: StoredNote,
	resolve: MigrationResolver,
	whenLoaded: ((entityId: string) => Promise<void>) | undefined,
): Promise<PerNotePatch | null> {
	const legacy = note.bodyLegacy;
	const hasLegacy = legacy !== undefined;
	const handle = resolve(note.id);
	try {
		// Force the snapshot apply ONLY for notes we might plant into (legacy
		// content to migrate). `whenLoaded` triggers `applyPending` on the
		// SHARED resolver entry; if an editor is concurrently mounting that doc,
		// the apply lands before its `@lexical/yjs` binding registers
		// `observeDeep` — the update events fire into a void and the note
		// renders blank even though the Y.Doc is full (the "open a doc and it's
		// empty" report; the boot scan races every note the user opens during
		// it). No-legacy notes have nothing to plant, so they never need the
		// forced apply — their snippet is read opportunistically if a binding
		// already hydrated the doc, and otherwise maintained by the seeder /
		// autosave. A stale denormalised snippet is cosmetic; a blank note is not.
		if (hasLegacy && whenLoaded) await withTimeout(whenLoaded(note.id), WHEN_LOADED_TIMEOUT_MS);
		const body = getUniversalBody(handle.doc);
		const docEmpty = isUniversalBodyEmpty(handle.doc);
		// A doc that has block-level elements but zero inline text past the
		// stored title was written by the structured-clone-broken preload
		// resolver (the title prepend committed; the body sync threw mid-
		// transaction). Treat it as empty so the legacy body can be
		// re-planted; the orphan title/paragraph stubs get cleared below
		// inside the same Yjs transaction that plants the fresh content.
		const isCorruptStub =
			!docEmpty && hasLegacy && isLegacyEditorState(legacy) && !hasInlineText(body, note.title);
		// Seeder-owned rows (`doc-docs-*`, `iteration-*`) are regenerated
		// from source on every `seed-cli` run — `bodyLegacy` is the freshly
		// seeded content the backfill just wrote, so it MUST land in the
		// editor's Y.Doc even when an older replica is on disk. Without
		// this, the seeder enriches kv + entities.db but the Notes view
		// keeps showing the stale Y.Doc forever.
		const isSeededReplant = hasLegacy && !docEmpty && isSeederOwnedNote(note.id);

		if ((docEmpty || isCorruptStub || isSeededReplant) && isLegacyEditorState(legacy)) {
			// Pre-title-node legacy bodies have no TitleNode at root[0].
			// The live editor would synthesize one via TitlePlugin's
			// RootNode transform on next open, but folding `note.title`
			// in here means the planted Y.Doc already carries the title
			// — cold-cache snippet + future Graph/Database surfaces see
			// the right shape without depending on the live mount.
			const titleFolded = migrateTitleIntoBody(legacy, note.title) as SerializedEditorState;
			if (isCorruptStub || isSeededReplant) clearUniversalBody(handle.doc);
			plantSerializedStateIntoDoc(handle.doc, titleFolded);
			const snippet = bodyToSnippet(body);
			return {
				outcome: MigrationOutcome.Planted,
				fields: { body: snippet },
			};
		}

		if (hasLegacy && !docEmpty) {
			const snippet = bodyToSnippet(body);
			if (snippet === note.body) return null;
			return {
				outcome: MigrationOutcome.ClobberAvoided,
				fields: { body: snippet },
			};
		}

		if (!docEmpty && note.body === "") {
			const snippet = bodyToSnippet(body);
			if (snippet === "") return null;
			return {
				outcome: MigrationOutcome.SnippetOnly,
				fields: { body: snippet },
			};
		}

		// Recompute the snippet for any non-empty doc whose stored snippet
		// disagrees with the fresh walker. Catches: (a) `[object Object]`
		// corruption left by the pre-2026-05-22 toString walker, and (b)
		// any drift between the doc and the denormalised mirror.
		if (!docEmpty) {
			const snippet = bodyToSnippet(body);
			if (snippet !== note.body) {
				return {
					outcome: MigrationOutcome.SnippetOnly,
					fields: { body: snippet },
				};
			}
		}

		if (hasLegacy && !isLegacyEditorState(legacy)) {
			// String-legacy or malformed object — nothing to plant, but
			// it's still recoverable via `bodyLegacy`. Mark as Failed so
			// the summary reflects the unrecoverable row.
			return {
				outcome: MigrationOutcome.Failed,
				fields: {},
			};
		}

		return null;
	} finally {
		handle.release();
	}
}

/** Mutate `note` in place. The orchestrator already holds the React
 *  Map; the in-place patch means the caller's `setNotes(new Map(prev))`
 *  on the next render observes the migrated row without a per-row state
 *  update during the boot scan. The pristine `bodyLegacy` field is
 *  never touched here — preserving the rollback escape-hatch. */
function applyPatchInPlace(note: StoredNote, patch: Partial<StoredNote>): void {
	if (patch.body !== undefined) note.body = patch.body;
}

/** Structural check that matches the codec's `isLegacyEditorStateLike`
 *  (kept in sync deliberately; the migration only plants what the codec
 *  classifies as legacy). */
export function isLegacyEditorState(value: unknown): value is SerializedEditorState {
	if (!value || typeof value !== "object") return false;
	const root = (value as { root?: unknown }).root;
	if (!root || typeof root !== "object") return false;
	const r = root as { type?: unknown; children?: unknown };
	return r.type === "root" && Array.isArray(r.children);
}

/** True when the universal body has any inline text past (an optional
 *  copy of) the note's stored title — used to detect the "title-attached
 *  but body sync aborted" corruption pattern from the structured-clone
 *  preload regression. Reads `body.toString()` (Yjs already concatenates
 *  text recursively across nested `Y.XmlText` children) and compares it
 *  to the stored title.
 *
 *  Conservative on purpose: a real-but-tiny edit ("ok" in the paragraph)
 *  reads as inline text and the doc is left alone (the clobber-avoidance
 *  branch handles it). The repair branch only triggers when the doc
 *  contains *exactly* the stored title (or less) — every observed corrupt
 *  file matches that shape. */
export function hasInlineText(body: XmlText, storedTitle: string): boolean {
	const flat = body.toString().trim();
	if (flat.length === 0) return false;
	const normalisedTitle = storedTitle.trim();
	if (normalisedTitle.length === 0) return true;
	return flat !== normalisedTitle;
}

/** Wipe the universal body root in a single Yjs transaction — used to
 *  clear the orphan title/paragraph stubs from a corrupt doc before
 *  re-planting the legacy body. Safe-by-shape: only called on docs that
 *  failed `hasInlineText`, so no user text is at risk. */
export function clearUniversalBody(doc: Doc): void {
	const body = getUniversalBody(doc);
	if (body.length === 0) return;
	doc.transact(() => {
		body.delete(0, body.length);
	});
}

/** Thin alias for the shared `@brainstorm-os/editor` helper — kept for
 *  call-site readability. Notes' plant must include `MIGRATION_NODES`
 *  (BASELINE + every Notes-specific custom node referenced by the
 *  legacy state); Journal's plant only needs BASELINE. */
export function plantSerializedStateIntoDoc(doc: Doc, serialized: SerializedEditorState): void {
	plantViaSharedHelper(doc, serialized, {
		nodes: MIGRATION_NODES,
		namespace: "notes-migrate",
	});
}

async function readMigrationStamp(storage: Pick<StorageService, "get">): Promise<string | null> {
	try {
		const raw = await storage.get<string>(MIGRATION_VERSION_KEY);
		return typeof raw === "string" ? raw : null;
	} catch (err) {
		console.warn("[notes/migrate-body] stamp read failed:", err);
		return null;
	}
}

function fastPathSummary(): MigrationSummary {
	return Object.freeze({
		scanned: 0,
		planted: 0,
		snippetOnly: 0,
		clobberAvoided: 0,
		failed: 0,
		skipped: 0,
		fastPath: true,
	});
}

function countOutcome(
	tally: {
		planted: number;
		snippetOnly: number;
		clobberAvoided: number;
		failed: number;
		skipped: number;
	},
	outcome: MigrationOutcome,
): void {
	switch (outcome) {
		case MigrationOutcome.Planted:
			tally.planted += 1;
			break;
		case MigrationOutcome.SnippetOnly:
			tally.snippetOnly += 1;
			break;
		case MigrationOutcome.ClobberAvoided:
			tally.clobberAvoided += 1;
			break;
		case MigrationOutcome.Failed:
			tally.failed += 1;
			break;
		case MigrationOutcome.Skipped:
			tally.skipped += 1;
			break;
	}
}

function emitError(opts: RunVaultBodyMigrationOptions, note: StoredNote, err: unknown): void {
	if (opts.onError) {
		opts.onError(note, err);
		return;
	}
	console.warn(`[notes/migrate-body] note ${note.id} failed:`, err);
}

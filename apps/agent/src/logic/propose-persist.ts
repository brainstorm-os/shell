/**
 * Agent-11b — the APPROVAL half of the propose path: map a user-approved
 * {@link ProposedArtifact} to the exact property bag its owner app renders.
 *
 * The model proposes with friendly, stable arg names (`title`, `notes`,
 * `dueDate`, …); each owner app persists a different schema (a Task's title is
 * `name`, its due date is the epoch-ms `dueAt`; an Event's body is
 * `description`; a Person's is `bio`; Notes/Bookmarks synthesize
 * `createdAt`/`updatedAt`/`tags`). This pure mapper is that translation — the
 * schema-aware coercion the owner asked for (coverage tier 1: simple entities).
 *
 * SECURITY: this runs ONLY on a human approval gesture in `app.tsx`, never in
 * the model loop. It is a pure `(artifact, now) → {entityType, properties}`; the
 * `entities.create` call (the actual `entities.write:<type>` exercise) is the
 * caller's, so this stays framework-free and exhaustively unit-testable.
 */

import {
	MEMBERS_HARD_CAP,
	type MemberOverrides,
	coerceScalarValue,
} from "@brainstorm-os/sdk-types";
import { CodeLanguage } from "@brainstorm-os/sdk/language-detect";
import {
	CodeFileConflictChoice,
	type CodeFilePathRow,
	findCodeFilePathConflict,
	nextFreeCodeFilePath,
} from "./code-file-conflict";
import { ProposeKind, type ProposedArtifact } from "./propose-artifacts";

/** A ready-to-persist plan: the canonical owner-app type + the full property bag
 *  (required fields synthesized) for one `entities.create`. */
export type ProposalPersistPlan = {
	entityType: string;
	properties: Record<string, unknown>;
};

/** Parse a model-supplied date/time string to epoch-ms, or null when it isn't a
 *  real date (the owner schemas accept `null` for optional temporal fields, so a
 *  vague "next week" degrades to unset rather than a bogus timestamp). */
function toEpochMs(value: string | undefined): number | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
}

/** Only spread a property when the model actually supplied it — keeps the
 *  created entity's bag minimal (no empty-string `location`/`email`/…). */
function opt(key: string, value: string | undefined): Record<string, string> {
	return value ? { [key]: value } : {};
}

/**
 * Translate an approved proposal into the create payload its owner app expects.
 * `now` is injected (epoch-ms) so the synthesized `createdAt`/`updatedAt`/
 * `savedAt` are deterministic in tests. The `id` is left to `entities.create`
 * to mint — a proposal is always a NEW object.
 */
export function proposalToEntityProperties(
	artifact: ProposedArtifact,
	now: number,
): ProposalPersistPlan {
	const f = artifact.fields;
	const type = artifact.entityType;
	switch (artifact.kind) {
		case ProposeKind.Note:
			// `body` rides the plain-text property; the Notes editor rebuilds its
			// state from it when there's no `richBody` (the legacy-body path).
			return {
				entityType: type,
				properties: {
					title: f.title ?? "",
					body: f.body ?? "",
					values: {},
					createdAt: now,
					updatedAt: now,
				},
			};
		case ProposeKind.Task:
			return {
				entityType: type,
				properties: {
					name: f.title ?? "",
					...opt("notes", f.notes),
					statusKey: null,
					completedAt: null,
					priority: "none",
					dueAt: toEpochMs(f.dueDate),
					scheduledAt: null,
					values: {},
					createdAt: now,
					updatedAt: now,
				},
			};
		case ProposeKind.Event: {
			// `start` is required by the Event schema — a vague/absent start
			// degrades to "now" so the created event is never schema-invalid.
			const start = toEpochMs(f.start) ?? now;
			return {
				entityType: type,
				properties: {
					title: f.title ?? "",
					...opt("description", f.notes),
					start,
					end: toEpochMs(f.end),
					allDay: false,
					...opt("location", f.location),
					createdAt: now,
					updatedAt: now,
				},
			};
		}
		case ProposeKind.Bookmark:
			return {
				entityType: type,
				properties: {
					url: f.url ?? "",
					title: f.title ?? "",
					...opt("notes", f.note),
					tags: [],
					savedAt: now,
					createdAt: now,
					updatedAt: now,
				},
			};
		case ProposeKind.Contact:
			return {
				entityType: type,
				properties: {
					name: f.name ?? "",
					...opt("email", f.email),
					...opt("phone", f.phone),
					...opt("company", f.company),
					...opt("bio", f.notes),
				},
			};
		case ProposeKind.CodeFile: {
			// AppForge-3 — mirrors the Code editor's own new-file create
			// (`{path, content, language}`): the source text lives in the
			// `content` property, which the editor seeds its Y.Doc buffer from
			// on first open. `sizeBytes`/`lineCount` are the manifest schema's
			// optional metadata, derived from the same content.
			const content = f.content ?? "";
			return {
				entityType: type,
				properties: {
					path: f.path ?? "",
					content,
					language: artifact.codeFile?.language ?? CodeLanguage.PlainText,
					sizeBytes: new TextEncoder().encode(content).length,
					lineCount: content.length === 0 ? 0 : content.split("\n").length,
					createdAt: now,
					updatedAt: now,
				},
			};
		}
		case ProposeKind.Database:
			// A new database is a MULTI-entity create (Collection + its view + one
			// entity per seed row), so there is no single property bag to map:
			// `persistProposedDatabase` owns that path and `app.tsx` routes to it
			// before reaching here. Throwing keeps the switch exhaustive AND makes
			// a future mis-route loud instead of silently writing a half database.
			throw new Error("propose-database is persisted by persistProposedDatabase");
		case ProposeKind.Row: {
			// Agent-11d — the columns ARE the allowlist: only a column the target
			// database declares is written, each value coerced to that column's
			// type so the Database renders it as the right cell (a number as a
			// number, a date as Unix-ms) rather than a string that looks right.
			const properties: Record<string, unknown> = { createdAt: now, updatedAt: now };
			for (const column of artifact.row?.columns ?? []) {
				const value = coerceScalarValue(f[column.key], column.valueType);
				if (value !== undefined) properties[column.key] = value;
			}
			properties.name = f.name ?? "";
			return { entityType: type, properties };
		}
	}
}

/** The entities-service surface an approval needs. Narrowed to the two calls so
 *  the persist step is testable with a stub and the write footprint is legible:
 *  ONE create, plus ONE additive membership patch for a manual collection. */
export type ProposalEntitiesService = {
	create(
		type: string,
		properties: Record<string, unknown>,
		id?: string,
		provenance?: { conversationId: string },
	): Promise<{ id: string } | null>;
	update(id: string, patch: Record<string, unknown>): Promise<unknown>;
};

/** POLISH-FN-4 — an approval refused because the drafted path is already
 *  taken and the user has not said what to do about it. Thrown, not returned,
 *  so a caller that forgets to handle it FAILS rather than silently writing a
 *  duplicate: the whole point is that "create anyway" is unreachable. */
export class CodeFilePathConflictError extends Error {
	/** The path already occupied (the EXISTING row's spelling — what to show). */
	readonly path: string;
	/** The row occupying it, i.e. what `Update` would target. */
	readonly existingId: string;

	constructor(path: string, existingId: string) {
		super(`a code file already exists at ${path}`);
		this.name = "CodeFilePathConflictError";
		this.path = path;
		this.existingId = existingId;
	}
}

/** What an approval actually wrote. `codeFilePath` is the path the row landed
 *  on, which differs from the card's when the user chose "Save a copy" — the
 *  app carries it forward so the next card at that path sees it as taken. */
export type PersistedProposal = {
	id: string;
	codeFilePath?: string;
};

/** The extra context an approval carries beyond the artifact itself. */
export type PersistProposalContext = {
	/** The conversation the proposal was made in — the provenance back-link.
	 *  Comes from the app's own active-chat state, never from model output. */
	conversationId: string | null;
	/** The target collection's current membership overrides (row proposals into
	 *  a manual collection only); read from the live snapshot. */
	collectionMembers?: MemberOverrides | undefined;
	/** Every code file the app can see (vault snapshot + this session's writes).
	 *  POLISH-FN-4: the path-conflict guard is judged against this. */
	existingCodeFiles?: readonly CodeFilePathRow[] | undefined;
	/** The user's answer to a path conflict. Absent = they were never asked, so
	 *  a conflicting create is REFUSED rather than resolved on their behalf. */
	codeFileChoice?: CodeFileConflictChoice | undefined;
	now: number;
};

function provenanceOf(context: PersistProposalContext): { conversationId: string } | undefined {
	return context.conversationId ? { conversationId: context.conversationId } : undefined;
}

/**
 * Persist an APPROVED proposal — the one place a proposal becomes vault bytes.
 * Called only from the approve gesture in `app.tsx` (never the model loop):
 * map → create (provenance-stamped, Agent-11c) → pin membership when the target
 * is a manual collection (Agent-11d). The membership patch is computed by
 * {@link memberPinPatch}, so an approval can only ever ADD the row it just
 * created to the collection the proposal named.
 *
 * A code file takes the {@link persistApprovedCodeFile} branch, which enforces
 * one-entity-per-path (POLISH-FN-4).
 */
export async function persistApprovedProposal(
	entities: ProposalEntitiesService,
	artifact: ProposedArtifact,
	context: PersistProposalContext,
): Promise<PersistedProposal | null> {
	const plan = proposalToEntityProperties(artifact, context.now);
	if (artifact.kind === ProposeKind.CodeFile) {
		return persistApprovedCodeFile(entities, plan, context);
	}
	const created = await entities.create(
		plan.entityType,
		plan.properties,
		undefined,
		provenanceOf(context),
	);
	if (artifact.row?.addToMembers && created?.id) {
		const patch = memberPinPatch(context.collectionMembers, created.id, context.now);
		if (patch) await entities.update(artifact.row.databaseId, patch);
	}
	return created;
}

/**
 * POLISH-FN-4 — the code-file write, with the one-entity-per-path invariant.
 *
 * `CodeFile/v1` has no uniqueness constraint on `path`, so nothing below this
 * function stops a second row at a path that is already taken; this IS the
 * constraint. Three outcomes, and no fourth:
 *
 *  - free path → create, as before;
 *  - taken + {@link CodeFileConflictChoice.Update} → write the content into the
 *    row that is already there. Its `path` is deliberately NOT rewritten, so a
 *    case-only difference (`Manifest.json` vs `manifest.json`) can't silently
 *    re-case a file the user named; `createdAt` is left alone too, because the
 *    file keeps its identity;
 *  - taken + {@link CodeFileConflictChoice.SaveCopy} → create at the next free
 *    path (`manifest-2.json`), the original untouched;
 *  - taken + no choice → {@link CodeFilePathConflictError}. Fail-closed: the
 *    user was never asked, so nothing is written.
 */
async function persistApprovedCodeFile(
	entities: ProposalEntitiesService,
	plan: ProposalPersistPlan,
	context: PersistProposalContext,
): Promise<PersistedProposal | null> {
	const existing = context.existingCodeFiles ?? [];
	const path = typeof plan.properties.path === "string" ? plan.properties.path : "";
	const conflict = findCodeFilePathConflict(existing, path);

	if (conflict === null) return createCodeFile(entities, plan, path, context);

	switch (context.codeFileChoice) {
		case CodeFileConflictChoice.Update:
			await entities.update(conflict.id, {
				content: plan.properties.content,
				language: plan.properties.language,
				sizeBytes: plan.properties.sizeBytes,
				lineCount: plan.properties.lineCount,
				updatedAt: context.now,
			});
			return { id: conflict.id, codeFilePath: conflict.path };
		case CodeFileConflictChoice.SaveCopy:
			return createCodeFile(entities, plan, nextFreeCodeFilePath(existing, path), context);
		default:
			throw new CodeFilePathConflictError(conflict.path, conflict.id);
	}
}

async function createCodeFile(
	entities: ProposalEntitiesService,
	plan: ProposalPersistPlan,
	path: string,
	context: PersistProposalContext,
): Promise<PersistedProposal | null> {
	const created = await entities.create(
		plan.entityType,
		{ ...plan.properties, path },
		undefined,
		provenanceOf(context),
	);
	return created ? { id: created.id, codeFilePath: path } : null;
}

/**
 * The additive member-pin patch for a row created in a MANUAL collection (one
 * with no type source to pick the row up). Pure + minimal on purpose: it
 * returns the collection's existing overrides with exactly one `include` entry
 * appended, so the approval can never rewrite membership it didn't add. `null`
 * when the row is already a member or the collection is at the hard cap.
 */
export function memberPinPatch(
	members: MemberOverrides | undefined,
	entityId: string,
	now: number,
): { members: MemberOverrides } | null {
	const include = members?.include ?? [];
	const exclude = members?.exclude ?? [];
	if (include.some((entry) => entry.entityId === entityId)) return null;
	if (include.length + exclude.length >= MEMBERS_HARD_CAP) return null;
	return {
		members: {
			include: [...include, { entityId, addedAt: now, by: "app:io.brainstorm.agent" }],
			exclude: [...exclude],
		},
	};
}

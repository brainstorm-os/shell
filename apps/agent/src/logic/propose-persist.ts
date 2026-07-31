/**
 * Agent-11b — the APPROVAL half of the propose path: turn a user-approved
 * {@link ProposedArtifact} into vault bytes.
 *
 * The pure `(artifact, now) → {entityType, properties}` mapper itself lives in
 * `@brainstorm-os/sdk-types` (`proposalToEntityProperties`), shared with the
 * main process and the other propose hosts. What stays here is the part that
 * touches the app's own services: the `entities.create` / `entities.update`
 * calls, the code-file path-conflict guard, and the manual-collection member
 * pin.
 *
 * SECURITY: this runs ONLY on a human approval gesture in `app.tsx`, never in
 * the model loop — the `entities.write:<type>` capability is exercised by the
 * user, not by model output.
 */

import {
	MEMBERS_HARD_CAP,
	type MemberOverrides,
	type ProposalPersistPlan,
	ProposeKind,
	type ProposedArtifact,
	proposalToEntityProperties,
} from "@brainstorm-os/sdk-types";
import {
	CodeFileConflictChoice,
	type CodeFilePathRow,
	findCodeFilePathConflict,
	nextFreeCodeFilePath,
} from "./code-file-conflict";

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

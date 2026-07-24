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

/**
 * Persist an APPROVED proposal — the one place a proposal becomes vault bytes.
 * Called only from the approve gesture in `app.tsx` (never the model loop):
 * map → create (provenance-stamped, Agent-11c) → pin membership when the target
 * is a manual collection (Agent-11d). The membership patch is computed by
 * {@link memberPinPatch}, so an approval can only ever ADD the row it just
 * created to the collection the proposal named.
 */
export async function persistApprovedProposal(
	entities: ProposalEntitiesService,
	artifact: ProposedArtifact,
	context: {
		/** The conversation the proposal was made in — the provenance back-link.
		 *  Comes from the app's own active-chat state, never from model output. */
		conversationId: string | null;
		/** The target collection's current membership overrides (row proposals into
		 *  a manual collection only); read from the live snapshot. */
		collectionMembers?: MemberOverrides | undefined;
		now: number;
	},
): Promise<{ id: string } | null> {
	const plan = proposalToEntityProperties(artifact, context.now);
	const created = await entities.create(
		plan.entityType,
		plan.properties,
		undefined,
		context.conversationId ? { conversationId: context.conversationId } : undefined,
	);
	if (artifact.row?.addToMembers && created?.id) {
		const patch = memberPinPatch(context.collectionMembers, created.id, context.now);
		if (patch) await entities.update(artifact.row.databaseId, patch);
	}
	return created;
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

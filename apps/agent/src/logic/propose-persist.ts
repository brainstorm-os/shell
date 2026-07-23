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
	}
}

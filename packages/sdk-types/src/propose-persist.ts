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
 * SECURITY: this runs ONLY on a human approval gesture, never in the model
 * loop. It is a pure `(artifact, now) → {entityType, properties}`; the
 * `entities.create` call (the actual `entities.write:<type>` exercise) is the
 * caller's, so this stays framework-free and exhaustively unit-testable.
 */

import { CodeLanguage } from "./code-language";
import { ProposeKind, type ProposedArtifact } from "./propose";
import { coerceScalarValue } from "./value-coerce";

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

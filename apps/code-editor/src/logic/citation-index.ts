/**
 * SH-14 keystone — the pure citation index.
 *
 * The dev MCP server's plan + open-question ledger is projected into
 * the vault as `Iteration/v1` / `OpenQuestion/v1` entities (SH-5/SH-6).
 * The Code-Editor already loads the whole vault snapshot to filter its
 * `CodeFile/v1` rows; this builds a second view over the same snapshot:
 * a code → entry index the scanner resolves buffer tokens against.
 *
 * This is the rung that survives the 9.7.2 editor swap. The plain
 * `<textarea>` can't decorate substrings, so the renderer surfaces
 * citations as a side panel today; when the real editor lands the
 * inline hover/decoration reads the *same* index + scanner — only the
 * presentation changes.
 */

import {
	type OpenQuestionEntity,
	OpenQuestionStatus,
	SelfHostingEntityType,
} from "@brainstorm-os/sdk-types";
import type { VaultSnapshot } from "../runtime";

export enum CitationKind {
	Iteration = "iteration",
	OpenQuestion = "open-question",
}

export interface CitationEntry {
	kind: CitationKind;
	/** Upper-cased lookup key (what the scanner matches against). */
	key: string;
	/** Code exactly as authored — `9.14.1.5`, `SH-14`, `OQ-GR-1`. */
	code: string;
	entityId: string;
	entityType: string;
	title: string;
	/** Raw status string from the entity (`done` / `open` / …). */
	status: string;
	/** One-line gloss: an iteration's summary, or an OQ's resolution
	 *  (falling back to its question). Empty when the entity carried none. */
	summary: string;
}

export type CitationIndex = ReadonlyMap<string, CitationEntry>;

/** Codes are case-folded for lookup so a buffer's `oq-gr-1` still
 *  resolves the canonical `OQ-GR-1` entry. */
export function normalizeCode(raw: string): string {
	return raw.trim().toUpperCase();
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function iterationSummary(props: Record<string, unknown>): string {
	return str(props.summary);
}

function openQuestionSummary(props: Record<string, unknown>): string {
	const resolution = str(props.resolution);
	if (resolution) return resolution;
	return str((props as Partial<OpenQuestionEntity>).question);
}

/**
 * Fold a vault snapshot into a code → {@link CitationEntry} map. A row
 * with no `code`, a soft-deleted row, or a non-self-hosting type is
 * skipped. When two live rows claim the same code the most-recently
 * updated one wins, so a re-seed that supersedes a stale projection is
 * reflected without a restart.
 */
export function buildCitationIndex(snapshot: VaultSnapshot | undefined | null): CitationIndex {
	const index = new Map<string, CitationEntry>();
	if (!snapshot?.entities) return index;
	const updatedAtByKey = new Map<string, number>();

	for (const entity of snapshot.entities) {
		if (entity.deletedAt !== null) continue;
		let kind: CitationKind;
		if (entity.type === SelfHostingEntityType.Iteration) kind = CitationKind.Iteration;
		else if (entity.type === SelfHostingEntityType.OpenQuestion) kind = CitationKind.OpenQuestion;
		else continue;

		const props = entity.properties ?? {};
		const code = str(props.code);
		if (!code) continue;
		const key = normalizeCode(code);

		const updatedAt = num(entity.updatedAt);
		const prevUpdatedAt = updatedAtByKey.get(key);
		if (prevUpdatedAt !== undefined && prevUpdatedAt >= updatedAt) continue;

		const title = str(props.title) || code;
		const status =
			str(props.status) || (kind === CitationKind.OpenQuestion ? OpenQuestionStatus.Open : "");
		const summary =
			kind === CitationKind.Iteration ? iterationSummary(props) : openQuestionSummary(props);

		index.set(key, {
			kind,
			key,
			code,
			entityId: entity.id,
			entityType: entity.type,
			title,
			status,
			summary,
		});
		updatedAtByKey.set(key, updatedAt);
	}
	return index;
}

/** Resolve a raw (possibly mixed-case) code against the index. */
export function lookupCitation(index: CitationIndex, rawCode: string): CitationEntry | undefined {
	return index.get(normalizeCode(rawCode));
}

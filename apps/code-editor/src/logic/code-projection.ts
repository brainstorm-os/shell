/**
 * Pure projection: a vault snapshot → the `CodeFile/v1` rows the
 * renderer lists + edits. Mirrors the read-half posture every migrated
 * app took (journal `notesFromSnapshot`, files `buildVaultFileTree`):
 * the aggregator surfaces real `entities.db` rows, this filters them to
 * our one type and maps the (possibly malformed) property bag onto the
 * frozen `CodeFile` contract.
 *
 * v1 keeps the source text in the entity's `content` property (the
 * body→Y.Doc transport is a deliberately-last rung mirroring Notes
 * 9.3.5.N-notes.4 — until then the property bag is the source of
 * truth, exactly as the other preview-drop apps did). A row whose
 * `content` is absent degrades to an empty buffer rather than dropping
 * the file.
 */

import { STYLE_PACK_TYPE_URL } from "@brainstorm/sdk-types";
import { type Icon, parseIcon } from "@brainstorm/sdk/entity-icon";
import { CODE_FILE_ENTITY_TYPE, type VaultEntity, type VaultSnapshot } from "../runtime";
import { type CodeFile, LanguageKey, isLanguageKey } from "../types/code-file";
import { resolveLanguage } from "./language-detect";

export interface CodeFileRow extends CodeFile {
	/** The editable source text. Held in the property bag in v1. */
	content: string;
	/** Which property key the editable text round-trips through. `content`
	 *  for a native `CodeFile/v1`; `css` for an adapted `StylePack/v1`
	 *  opened via the cross-app handoff. The save path writes back to this
	 *  key so a StylePack's CSS lands in `properties.css` (where the
	 *  theme-editor + validators read it), not a foreign `content`. */
	contentKey: "content" | "css";
	/** The object's OWN universal icon, validated off the property bag
	 *  via the shared `parseIcon` — `null` when absent/malformed, in
	 *  which case the renderer falls back to the type glyph (per
	 *  §Per-object icons
	 *  everywhere). Never derived from `type`. */
	icon: Icon | null;
	/** Read-only lock — the file's synced `locked` property. When true the
	 *  editor surface is read-only. */
	locked: boolean;
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function numOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Map one vault entity's property bag onto a `CodeFileRow`. The
 *  language falls back to extension/MIME/shebang detection when the
 *  stored value isn't a known `LanguageKey`, so a row written by an
 *  importer that didn't classify the file still highlights correctly
 *  once the highlighter lands. */
export function entityToCodeFileRow(entity: {
	id: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}): CodeFileRow {
	const props = entity.properties;
	const content = str(props.content) || str(props.body);
	const path = str(props.path, entity.id);
	const storedLang = props.language;
	const language = isLanguageKey(storedLang)
		? storedLang
		: resolveLanguage({ path, firstLine: content.split("\n", 1)[0] ?? "" });
	return {
		id: entity.id,
		path,
		language: language === LanguageKey.Unknown ? LanguageKey.PlainText : language,
		content,
		contentKey: "content",
		icon: parseIcon(props.icon),
		locked: props.locked === true,
		sizeBytes: numOrNull(props.sizeBytes),
		lineCount: numOrNull(props.lineCount),
		isDirty: props.isDirty === true,
		lastOpenedAt: numOrNull(props.lastOpenedAt),
		createdAt: entity.createdAt,
		updatedAt: entity.updatedAt,
	};
}

/** Adapt a `brainstorm/StylePack/v1` entity into an editable row — its CSS
 *  (`properties.css`) becomes the buffer, forced to the `css` language, and
 *  edits round-trip back through `properties.css` (`contentKey`). The
 *  cross-app handoff from the theme-editor opens these. */
export function entityToStylePackRow(entity: {
	id: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}): CodeFileRow {
	const props = entity.properties;
	const name = str(props.name).trim();
	return {
		id: entity.id,
		path: name.length > 0 ? `${name}.css` : "style-pack.css",
		language: LanguageKey.CSS,
		content: str(props.css),
		contentKey: "css",
		icon: parseIcon(props.icon),
		locked: props.locked === true,
		sizeBytes: null,
		lineCount: null,
		isDirty: false,
		lastOpenedAt: null,
		createdAt: entity.createdAt,
		updatedAt: entity.updatedAt,
	};
}

/** Filter a snapshot to live `CodeFile/v1` rows, mapped + sorted by
 *  `path` (case-insensitive) with the most-recently-updated first on a
 *  tie. Soft-deleted rows are dropped.
 *
 *  `openStylePackId` opts a single `StylePack/v1` object into the list — the
 *  one the theme-editor handed off via the `open` intent — adapted into an
 *  editable CSS row. StylePacks are NOT listed by default (they'd clutter a
 *  code workspace); only the explicitly-opened one is surfaced. */
export function projectCodeFiles(
	snapshot: VaultSnapshot,
	openStylePackId?: string | null,
): CodeFileRow[] {
	const rows: CodeFileRow[] = [];
	for (const entity of snapshot.entities) {
		if (entity.type !== CODE_FILE_ENTITY_TYPE) continue;
		if (entity.deletedAt !== null) continue;
		rows.push(entityToCodeFileRow(entity));
	}
	rows.sort(
		(a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()) || b.updatedAt - a.updatedAt,
	);
	if (openStylePackId) {
		const pack = findOpenStylePack(snapshot.entities, openStylePackId);
		if (pack) rows.push(entityToStylePackRow(pack));
	}
	return rows;
}

function findOpenStylePack(entities: VaultEntity[], id: string): VaultEntity | null {
	for (const entity of entities) {
		if (entity.id !== id) continue;
		if (entity.type !== STYLE_PACK_TYPE_URL || entity.deletedAt !== null) return null;
		return entity;
	}
	return null;
}

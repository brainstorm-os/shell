/**
 * Explicit-attachment context (composer context rail → the agent). Where
 * `retrieval.ts` is the broker's AUTOMATIC grounding (hybrid search over the
 * user's query), this is the context the user EXPLICITLY pinned to the turn:
 * the documents / people they @-mentioned or linked in the composer. It's a
 * higher-signal block — the user asked for THIS object — so it gets a generous
 * per-reference text budget and is injected ahead of auto-retrieval.
 *
 * Pure + deterministic: it takes the attachments plus a resolver
 * (id → {@link ReferencedEntity}) the app builds from the live vault snapshot
 * (the Agent app holds `entities.read:*`), so the bounded / fail-soft behaviour
 * is unit-testable without a vault. Media attachments are skipped here — they
 * land via text-extraction (Phase 2) / image vision (Phase 3).
 */

import { AttachmentKind, type MessageAttachment } from "@brainstorm-os/sdk-types";

/** A resolved vault object, reduced to what grounding needs. */
export type ReferencedEntity = {
	id: string;
	type: string;
	title: string;
	/** Plain-text excerpt drawn from the entity's text-bearing properties. */
	text: string;
};

/** Per-reference text budget — explicit references get more room than an
 *  auto-retrieval snippet (the user pinned THIS object), but still bounded so a
 *  large note can't blow up the prompt. */
export const REFERENCE_TEXT_MAX = 1500;
/** Hard cap on how many references are injected, defensive against a runaway
 *  rail. */
export const REFERENCE_MAX = 12;

const TITLE_KEYS = ["title", "name", "label"] as const;
const TEXT_KEYS = ["body", "text", "content", "description", "summary", "snippet", "note"] as const;

/** Strip C0/C1/DEL control chars (a codepoint filter, not a control-char regex
 *  literal — keeps biome's `noControlCharactersInRegex` happy without a
 *  suppression, mirroring `identity.ts`), collapse whitespace, trim. */
function clean(value: unknown): string {
	if (typeof value !== "string") return "";
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : ch;
	}
	return out.replace(/\s+/g, " ").trim();
}

function clamp(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The entity's display title from its common title-bearing properties, falling
 *  back to the id. */
export function entityTitle(properties: Record<string, unknown>, fallbackId: string): string {
	for (const key of TITLE_KEYS) {
		const value = clean(properties[key]);
		if (value) return value;
	}
	return fallbackId;
}

/** A plain-text excerpt from the entity's text-bearing properties (Yjs richtext
 *  bodies live outside `properties`, so this is the denormalised text mirror —
 *  title/snippet/description/etc. — that grounds the agent without a doc read). */
export function entityPlainText(properties: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const key of TEXT_KEYS) {
		const value = clean(properties[key]);
		if (value) parts.push(value);
	}
	return parts.join("\n");
}

/** Reduce a live snapshot entity to a {@link ReferencedEntity}. */
export function toReference(entity: {
	id: string;
	type: string;
	properties: Record<string, unknown>;
}): ReferencedEntity {
	return {
		id: entity.id,
		type: entity.type,
		title: entityTitle(entity.properties, entity.id),
		text: entityPlainText(entity.properties),
	};
}

/**
 * Build the explicit-attachment instruction block, or `""` when nothing
 * resolves. Media attachments are skipped; entity/person references are resolved
 * (unresolvable ones — e.g. a since-deleted object — are dropped, fail-soft) and
 * rendered as titled, id-tagged sections so the model can cite them.
 */
export function buildAttachmentsContextBlock(
	attachments: readonly MessageAttachment[],
	resolve: (ref: string) => ReferencedEntity | null,
): string {
	const sections: string[] = [];
	for (const att of attachments) {
		if (att.kind === AttachmentKind.Media) continue;
		if (sections.length >= REFERENCE_MAX) break;
		const ent = resolve(att.ref);
		if (!ent) continue;
		const heading = att.kind === AttachmentKind.Person ? "Person" : "Document";
		const title = ent.title.trim() || clean(att.label) || ent.id;
		const lines = [`### ${heading}: ${title} [${ent.id}]`];
		const text = clamp(ent.text, REFERENCE_TEXT_MAX);
		if (text) lines.push(text);
		sections.push(lines.join("\n"));
	}
	if (sections.length === 0) return "";
	return [
		"The user explicitly attached the following context to this message. Ground your answer on it and cite the ones you use by their id:",
		...sections,
	].join("\n\n");
}

// ─── media (Phase 2: text extraction; Phase 3: image vision) ──────────────────

/** Text-bearing MIME types whose bytes the composer decodes as UTF-8 to ground
 *  the agent. Images are NOT here — they ride as vision content parts (Phase 3).
 *  Binary office/PDF extraction is a later rung. */
const TEXT_EXTRACTABLE_MIME: ReadonlySet<string> = new Set([
	"application/json",
	"application/xml",
	"application/x-yaml",
	"application/yaml",
	"text/csv",
	"text/markdown",
	"text/plain",
	"text/xml",
]);

/** Per-file text budget injected into the prompt — larger than an entity
 *  reference (a whole file), still bounded. */
export const MEDIA_TEXT_MAX = 4000;

function baseMime(mime: string): string {
	return (mime.toLowerCase().split(";")[0] ?? "").trim();
}

/** Whether an attached file's bytes should be decoded as text for grounding. */
export function isTextExtractableMime(mime: string): boolean {
	const m = baseMime(mime);
	return m.startsWith("text/") || TEXT_EXTRACTABLE_MIME.has(m);
}

/** Whether an attached file is an image (→ vision content part, Phase 3). */
export function isImageMime(mime: string): boolean {
	return baseMime(mime).startsWith("image/");
}

/**
 * Build the attached-media context block, or `""` when there is nothing to
 * report. Images are skipped (handled by the vision path). A file with extracted
 * text gets a titled section with its (clamped) contents; a non-extractable file
 * gets a one-line "present but not extracted" note so the agent at least knows it
 * exists. `mediaText` resolves a media `ref` to its decoded text (or null).
 */
export function buildMediaContextBlock(
	attachments: readonly MessageAttachment[],
	mediaText: (ref: string) => string | null,
): string {
	const sections: string[] = [];
	for (const att of attachments) {
		if (att.kind !== AttachmentKind.Media) continue;
		if (att.image) continue;
		const label = clean(att.label) || att.ref;
		const text = mediaText(att.ref);
		if (text?.trim()) {
			sections.push(
				`### Attached file: ${label} (${att.mediaType})\n${clamp(text.trim(), MEDIA_TEXT_MAX)}`,
			);
		} else {
			sections.push(
				`### Attached file: ${label} (${att.mediaType}) — binary; contents not extracted.`,
			);
		}
	}
	if (sections.length === 0) return "";
	return ["The user attached the following file(s) to this message:", ...sections].join("\n\n");
}

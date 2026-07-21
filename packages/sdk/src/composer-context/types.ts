/**
 * `@brainstorm-os/sdk/composer-context` — shared types + mapping helpers for the
 * composer "context rail": the affordance that lets a chat composer attach
 * explicit context to a turn (a pinned document, an @-mentioned person, an
 * uploaded media asset) so it reaches the agent. The durable wire shape is
 * `MessageAttachment` (sdk-types); this module owns the UI-side candidate type
 * the picker surfaces and the pure candidate→attachment mapping, so the Agent
 * app and a future Chats app build the same rail over different search sources.
 */

import {
	AttachmentKind,
	type EntityAttachment,
	type MediaAttachment,
	type MessageAttachment,
	type PersonAttachment,
} from "@brainstorm-os/sdk-types";
import { IconName } from "../icon";
import { type NoteReference, NoteReferenceKind, extractNoteReferences } from "../note-references";

/** Per-file upload ceiling for composer media — bounds the in-renderer
 *  base64 + provider payload (matches the broker's single-envelope upload cap).
 *  A larger file is rejected by the host before upload. */
export const MEDIA_BYTES_MAX = 25 * 1024 * 1024;

/** The chip / row glyph for an attachment kind. No dedicated person/image glyphs
 *  exist in the base registry, so person reuses the generic entity glyph and
 *  media the file glyph — the label disambiguates. Shared by the rail + every
 *  consumer that renders attachment chips. */
export function attachmentIcon(kind: AttachmentKind): IconName {
	if (kind === AttachmentKind.Media) return IconName.KindFile;
	if (kind === AttachmentKind.Person) return IconName.Entity;
	return IconName.KindLink;
}

/** A pickable context source surfaced in the mention typeahead / attach picker.
 *  Media is added via upload (not search), so a candidate is always an entity or
 *  a person — the two things the host's vault search can return. */
export type ContextCandidate = {
	/** The entity / person id (becomes the attachment `ref`). */
	id: string;
	kind: AttachmentKind.Entity | AttachmentKind.Person;
	/** Display name shown in the row + the resulting chip. */
	label: string;
	/** The entity's type url — drives the chip glyph + persisted `entityType`. */
	entityType?: string;
	/** Optional secondary line (a type name / snippet) shown under the label. */
	description?: string;
};

/** The host seam the primitive draws on. The host owns vault access (and its
 *  capability checks) and the media-upload flow; the primitive owns the UI. */
export type ComposerContextHost = {
	/** Host-owned search over the vault for attachable entities/people. Filtering
	 *  + ranking + cap enforcement live in the host; the primitive just renders
	 *  what comes back. */
	searchCandidates(query: string): Promise<readonly ContextCandidate[]>;
	/** Pick + upload a media asset, resolving to the attachment (or null when the
	 *  user cancels). Optional — when absent the attach picker omits the media
	 *  option. */
	attachMedia?(): Promise<MediaAttachment | null>;
};

/** Stable identity of an attachment within the draft list (its `ref`). The rail
 *  dedupes + removes by this key. */
export function attachmentKey(att: MessageAttachment): string {
	return att.ref;
}

/** Build the durable {@link MessageAttachment} from a picked candidate. Pure —
 *  optional fields are omitted (not set to `undefined`) so the persisted shape
 *  satisfies `exactOptionalPropertyTypes`. */
export function candidateToAttachment(
	candidate: ContextCandidate,
): EntityAttachment | PersonAttachment {
	const label = candidate.label.trim();
	if (candidate.kind === AttachmentKind.Person) {
		return { kind: AttachmentKind.Person, ref: candidate.id, ...(label ? { label } : {}) };
	}
	return {
		kind: AttachmentKind.Entity,
		ref: candidate.id,
		...(label ? { label } : {}),
		...(candidate.entityType ? { entityType: candidate.entityType } : {}),
	};
}

/** The `@`-mention chips inlined in a message's rich body (a serialized
 *  Lexical state, as persisted on `richBody`). Two consumers share this: the
 *  send path lifts inline mentions into durable attachments (so the
 *  mention-notifier / agent grounding see them without re-parsing the body),
 *  and the transcript render hides the attachment chip whose mention already
 *  shows inline. Fail-soft: a missing / unparseable body yields `[]`. */
export function inlineMentionRefs(richBody: string | null | undefined): NoteReference[] {
	if (!richBody) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(richBody);
	} catch {
		return [];
	}
	return extractNoteReferences(parsed).filter((r) => r.kind === NoteReferenceKind.Mention);
}

/** The durable attachment for an inline mention chip. A mention with no
 *  entity type is a person keyed by sovereign pubkey (chat's roster people are
 *  not vault entities), as is a `…/Person/v1` entity; anything else is an
 *  entity reference. */
function mentionToAttachment(ref: NoteReference): PersonAttachment | EntityAttachment {
	if (ref.entityType === "" || ref.entityType.endsWith("/Person/v1")) {
		return {
			kind: AttachmentKind.Person,
			ref: ref.entityId,
			...(ref.label ? { label: ref.label } : {}),
		};
	}
	return {
		kind: AttachmentKind.Entity,
		ref: ref.entityId,
		...(ref.label ? { label: ref.label } : {}),
		entityType: ref.entityType,
	};
}

/** Lift the `@`-mention chips inlined in a rich body into durable attachments,
 *  merged after any explicitly-attached context (existing refs win). The
 *  mention lives in the text Slack-style, but the attachment is what the
 *  mention-notifier and agent grounding read — it travels on the wire without
 *  rendering as a chip (see {@link visibleAttachments}). */
export function withMentionAttachments(
	richBody: string | null | undefined,
	attachments: readonly MessageAttachment[],
): MessageAttachment[] {
	const seen = new Set(attachments.map((a) => a.ref));
	const lifted: MessageAttachment[] = [];
	for (const ref of inlineMentionRefs(richBody)) {
		if (seen.has(ref.entityId)) continue;
		seen.add(ref.entityId);
		lifted.push(mentionToAttachment(ref));
	}
	return [...attachments, ...lifted];
}

/** The attachments to render as chips under a message: one whose mention
 *  already shows inline in the rich body is hidden (it exists only as wire
 *  metadata). A legacy message with no inline mention keeps its chip; media is
 *  never mention-sourced so it always shows. */
export function visibleAttachments(message: {
	richBody?: string;
	attachments: readonly MessageAttachment[];
}): MessageAttachment[] {
	const attachments = [...message.attachments];
	if (!message.richBody || attachments.length === 0) return attachments;
	const inline = new Set(inlineMentionRefs(message.richBody).map((r) => r.entityId));
	if (inline.size === 0) return attachments;
	return attachments.filter((a) => a.kind === AttachmentKind.Media || !inline.has(a.ref));
}

/** The label to render for an attachment chip — the denormalised label, falling
 *  back to the raw ref when none was captured. */
export function attachmentLabel(att: MessageAttachment): string {
	const label = att.label?.trim();
	return label && label.length > 0 ? label : att.ref;
}

/** Hard cap on attachments parsed off one Message. A `Message/v1` can be written
 *  by another sandboxed app or a synced peer, so a hostile blob could carry an
 *  enormous `attachments` array — the chip renderers map the FULL parsed list, so
 *  an uncapped parse is a render-DoS. 24 is well past any real composer use. */
export const ATTACHMENTS_MAX = 24;
/** Sanity caps on untrusted attachment fields (a peer-writable blob). A `ref`
 *  beyond this can't be a real entity id / asset url; a label is denormalised
 *  display text and is clamped, not dropped. */
const REF_MAX_LEN = 2048;
const LABEL_MAX_LEN = 256;

/** Parse a persisted `attachments` blob back to typed attachments, dropping any
 *  malformed member (the property store is loosely typed, and a hostile peer
 *  could write anything) and bounding both the count and per-field sizes. Shared
 *  by every consumer that reads attachments off a Message entity (the Agent app,
 *  the Chats app). */
export function parseAttachments(raw: unknown): MessageAttachment[] {
	if (!Array.isArray(raw)) return [];
	const out: MessageAttachment[] = [];
	for (const item of raw) {
		if (out.length >= ATTACHMENTS_MAX) break;
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		const ref = rec.ref;
		if (typeof ref !== "string" || !ref || ref.length > REF_MAX_LEN) continue;
		const label = typeof rec.label === "string" ? rec.label.slice(0, LABEL_MAX_LEN) : undefined;
		if (rec.kind === AttachmentKind.Entity) {
			out.push({
				kind: AttachmentKind.Entity,
				ref,
				...(label ? { label } : {}),
				...(typeof rec.entityType === "string" ? { entityType: rec.entityType } : {}),
			});
		} else if (rec.kind === AttachmentKind.Person) {
			out.push({ kind: AttachmentKind.Person, ref, ...(label ? { label } : {}) });
		} else if (rec.kind === AttachmentKind.Media && typeof rec.mediaType === "string") {
			out.push({
				kind: AttachmentKind.Media,
				ref,
				mediaType: rec.mediaType,
				...(label ? { label } : {}),
				...(typeof rec.image === "boolean" ? { image: rec.image } : {}),
				...(typeof rec.bytes === "number" ? { bytes: rec.bytes } : {}),
			});
		}
	}
	return out;
}

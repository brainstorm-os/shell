/**
 * Pure Chat logic — deriving channels + threaded messages from the live vault
 * snapshot, ordering, author colouring, and grouping. No React, no DOM, no
 * services: everything here is a pure function of plain data so it unit-tests
 * without a vault or a renderer (the app's `app.tsx` is a thin shell over it).
 *
 * Channels are the app-owned `io.brainstorm.chat/Channel/v1`; messages reuse
 * the shared `brainstorm/Message/v1` substrate (the messaging-compatible
 * foundation in `@brainstorm-os/sdk-types` `conversation.ts`) with the
 * `participant` sender carrying the human author — so a Chat message is the
 * same entity an Agent transcript turn is, just authored by a person.
 */

import {
	MESSAGE_TYPE_URL,
	type MessageAttachment,
	type MessageDef,
	MessageRole,
	type RosterMember,
	type RosterRole,
	SenderKind,
} from "@brainstorm-os/sdk-types";
import { parseAttachments } from "@brainstorm-os/sdk/composer-context";

/** The Chat-owned channel type (a channel is NOT an AI `Conversation/v1`, so
 *  it never collides with the Agent app's primary opener). */
export const CHANNEL_TYPE = "io.brainstorm.chat/Channel/v1";
/** Re-exported for the app + tests so the shared substrate id has one name. */
export const MESSAGE_TYPE = MESSAGE_TYPE_URL;

/** The minimal entity shape this module reads — a structural subset of the
 *  SDK `VaultEntity`, so helpers test against plain objects. */
export type EntityLike = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
};

export type ChatChannel = {
	id: string;
	name: string;
	topic: string;
	createdAt: string;
};

export type ChatMessage = {
	id: string;
	channelId: string;
	body: string;
	/** Serialized Lexical state (JSON) when the message was authored in the rich
	 *  composer. Renderers prefer it and fall back to the plain `body`. */
	richBody?: string;
	/** Stable author key (the participant `personRef`) — drives colour + grouping. */
	authorRef: string;
	/** The author's display name at send time (denormalised onto the message). */
	authorName: string;
	createdAt: string;
	seq: number;
	/** Context the author attached to the message (documents / people / media) —
	 *  rendered as chips; the persona-agent reading the channel grounds on them. */
	attachments: MessageAttachment[];
};

/** One run of consecutive messages from the same author on the same day, within
 *  the grouping window — rendered with a single header (avatar + name + time). */
export type MessageGroup = {
	authorRef: string;
	authorName: string;
	color: string;
	/** `YYYY-MM-DD` of the group's first message (UTC) — the UI inserts a day
	 *  divider when this changes between groups. */
	dayKey: string;
	messages: ChatMessage[];
};

/** A distinct author seen in a channel — the member roster, derived from who
 *  has actually posted (no separate membership write, so no cross-device race). */
export type ChannelMember = {
	authorRef: string;
	authorName: string;
	color: string;
};

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ─────────────────────────────── channels ───────────────────────────────

export function toChannel(entity: EntityLike): ChatChannel {
	return {
		id: entity.id,
		name: str(entity.properties.name) || "untitled",
		topic: str(entity.properties.topic),
		createdAt: str(entity.properties.createdAt),
	};
}

/** Channels, oldest-created first (stable reading order; ties broken by id). */
export function deriveChannels(entities: readonly EntityLike[]): ChatChannel[] {
	return entities
		.filter((e) => e.type === CHANNEL_TYPE)
		.map(toChannel)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

// ─────────────────────────────── messages ───────────────────────────────

/** The author key + name for a message: the `participant` sender's `personRef`
 *  / `displayName` when present, falling back to the entity id / "Someone" so a
 *  malformed sender never crashes the render. */
function readAuthor(
	properties: Record<string, unknown>,
	fallbackId: string,
): {
	authorRef: string;
	authorName: string;
} {
	const sender = properties.sender;
	if (sender && typeof sender === "object") {
		const s = sender as Record<string, unknown>;
		const ref = str(s.personRef);
		const name = str(s.displayName);
		if (ref) return { authorRef: ref, authorName: name || ref };
	}
	return { authorRef: `anon:${fallbackId}`, authorName: "Someone" };
}

export function toMessage(entity: EntityLike): ChatMessage {
	const author = readAuthor(entity.properties, entity.id);
	const richBody = str(entity.properties.richBody);
	return {
		id: entity.id,
		channelId: str(entity.properties.conversation),
		body: str(entity.properties.body),
		...(richBody ? { richBody } : {}),
		authorRef: author.authorRef,
		authorName: author.authorName,
		createdAt: str(entity.properties.createdAt),
		seq: num(entity.properties.seq) ?? 0,
		attachments: parseAttachments(entity.properties.attachments),
	};
}

/** Order within a channel: monotonic `seq`, then wall-clock `createdAt`, then id
 *  — deterministic even when two devices stamp the same seq before converging. */
export function sortMessages(messages: readonly ChatMessage[]): ChatMessage[] {
	return [...messages].sort(
		(a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
	);
}

/** The ordered messages of one channel from the live snapshot. */
export function channelMessages(entities: readonly EntityLike[], channelId: string): ChatMessage[] {
	if (!channelId) return [];
	const rows = entities
		.filter((e) => e.type === MESSAGE_TYPE && str(e.properties.conversation) === channelId)
		.map(toMessage);
	return sortMessages(rows);
}

/** The next `seq` for a channel — one past the current max (0 for an empty
 *  channel). Local optimistic ordering; converges via the sort tiebreak. */
export function nextSeq(messages: readonly ChatMessage[]): number {
	let max = -1;
	for (const m of messages) if (m.seq > max) max = m.seq;
	return max + 1;
}

// ─────────────────────────────── grouping ───────────────────────────────

/** `YYYY-MM-DD` (UTC) of an ISO timestamp; "" when unparseable. */
export function dayKey(iso: string): string {
	const idx = iso.indexOf("T");
	return idx > 0 ? iso.slice(0, idx) : iso;
}

/** Messages within this many ms by the same author collapse into one group. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function msOf(iso: string): number {
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : 0;
}

/** Collapse consecutive same-author messages (same day, within the window) into
 *  groups so the UI shows one header per run rather than per message. Input is
 *  assumed pre-sorted by {@link sortMessages}. */
export function groupMessages(
	messages: readonly ChatMessage[],
	colorFor: (authorRef: string) => string,
): MessageGroup[] {
	const groups: MessageGroup[] = [];
	for (const m of messages) {
		const last = groups[groups.length - 1];
		const sameRun =
			last !== undefined &&
			last.authorRef === m.authorRef &&
			last.dayKey === dayKey(m.createdAt) &&
			msOf(m.createdAt) - msOf(last.messages[last.messages.length - 1]?.createdAt ?? "") <=
				GROUP_WINDOW_MS;
		if (sameRun && last) {
			last.messages.push(m);
		} else {
			groups.push({
				authorRef: m.authorRef,
				authorName: m.authorName,
				color: colorFor(m.authorRef),
				dayKey: dayKey(m.createdAt),
				messages: [m],
			});
		}
	}
	return groups;
}

/** Distinct authors who have posted in the given messages, in first-seen order. */
export function membersFromMessages(
	messages: readonly ChatMessage[],
	colorFor: (authorRef: string) => string,
): ChannelMember[] {
	const seen = new Map<string, ChannelMember>();
	for (const m of messages) {
		if (!seen.has(m.authorRef)) {
			seen.set(m.authorRef, {
				authorRef: m.authorRef,
				authorName: m.authorName,
				color: colorFor(m.authorRef),
			});
		}
	}
	return [...seen.values()];
}

/** One row of the member panel: the authoritative roster (the channel's signed
 *  access record, resolved to names) plus any *legacy* author who has posted but
 *  isn't in the roster — an older message minted under the pre-pubkey author key,
 *  shown as a guest rather than dropped. The roster rows come first (self first);
 *  guests trail. `displayName` is "" when a member's profile hasn't resolved yet
 *  (the UI falls back to the fingerprint). */
export type PanelMember = {
	/** The pubkey (roster) or legacy author key — the React list key. */
	key: string;
	displayName: string;
	/** `ed25519:<hex>` for roster members; "" for legacy guests. */
	fingerprint: string;
	color: string;
	/** Serialized universal `Icon` the member set as their avatar, if any. */
	avatarRef?: string;
	isSelf: boolean;
	role?: RosterRole;
	legacy: boolean;
};

/** Merge the live roster with the message-derived authors into the panel list.
 *  A poster already in the roster (the common case — every new message is
 *  authored by the pubkey) is NOT duplicated as a guest. */
export function toPanelMembers(args: {
	roster: readonly RosterMember[];
	messageMembers: readonly ChannelMember[];
	colorFor: (key: string) => string;
}): PanelMember[] {
	const out: PanelMember[] = [];
	const known = new Set<string>();
	for (const m of args.roster) {
		known.add(m.pubkey);
		out.push({
			key: m.pubkey,
			displayName: m.displayName ?? "",
			fingerprint: m.fingerprint,
			color: args.colorFor(m.pubkey),
			...(m.avatarRef ? { avatarRef: m.avatarRef } : {}),
			isSelf: m.isSelf,
			...(m.role ? { role: m.role } : {}),
			legacy: false,
		});
	}
	for (const a of args.messageMembers) {
		if (known.has(a.authorRef)) continue;
		known.add(a.authorRef);
		out.push({
			key: a.authorRef,
			displayName: a.authorName,
			fingerprint: "",
			color: args.colorFor(a.authorRef),
			isSelf: false,
			legacy: true,
		});
	}
	return out;
}

// ─────────────────────────────── colour ───────────────────────────────

/** A fixed, theme-independent author palette. Literal hex on purpose (same
 *  rationale as the editor's `PEER_COLORS`): the colour is written straight into
 *  an inline `background`/`color`, where a `var(--…)` token would paint nothing. */
export const AUTHOR_COLORS = Object.freeze([
	"#5b8def",
	"#e0688b",
	"#34b27b",
	"#d9913a",
	"#9b7bea",
	"#3bb6c4",
	"#d2645a",
	"#7a8aa0",
]) as readonly string[];

/** Deterministic author colour: a sign-safe hash of the stable author key into
 *  {@link AUTHOR_COLORS}. Same author → same colour across every device. */
export function authorColor(authorRef: string): string {
	let hash = 0;
	for (let i = 0; i < authorRef.length; i++) {
		hash = (hash * 31 + authorRef.charCodeAt(i)) | 0;
	}
	const idx = ((hash % AUTHOR_COLORS.length) + AUTHOR_COLORS.length) % AUTHOR_COLORS.length;
	return AUTHOR_COLORS[idx] ?? AUTHOR_COLORS[0] ?? "#5b8def";
}

/** Up-to-two-letter avatar initials — the shared SDK helper (a second consumer
 *  is `<PresenceStack>`, so it lives in `@brainstorm-os/sdk/presence-stack`).
 *  Re-exported here so chat's existing importers are unchanged. */
export { presenceInitials as initials } from "@brainstorm-os/sdk/presence-stack";

// ─────────────────────────────── compose ───────────────────────────────

/** Build the `brainstorm/Message/v1` properties for a posted message — the
 *  `participant` sender carries the human author (mirrors the AI app's `user`
 *  sender, but for a person). `role` stays `user` (a participant reads as `user`
 *  to any transcript consumer, per `senderRole`). Pure so the wire shape is
 *  unit-tested without a service. */
export function buildMessageProperties(args: {
	channelId: string;
	body: string;
	richBody?: string;
	authorRef: string;
	authorName: string;
	createdAt: string;
	seq: number;
	attachments?: readonly MessageAttachment[];
}): MessageDef {
	return {
		conversation: args.channelId,
		sender: {
			kind: SenderKind.Participant,
			personRef: args.authorRef,
			displayName: args.authorName,
		},
		role: MessageRole.User,
		body: args.body,
		...(args.richBody ? { richBody: args.richBody } : {}),
		createdAt: args.createdAt,
		seq: args.seq,
		...(args.attachments && args.attachments.length > 0
			? { attachments: [...args.attachments] }
			: {}),
	};
}

/** Build the channel properties for a new channel. */
export function buildChannelProperties(args: {
	name: string;
	topic?: string;
	createdAt: string;
}): Record<string, unknown> {
	const props: Record<string, unknown> = { name: args.name.trim(), createdAt: args.createdAt };
	const topic = args.topic?.trim();
	if (topic) props.topic = topic;
	return props;
}

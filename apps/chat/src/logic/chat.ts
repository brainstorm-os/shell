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
	AGENT_TYPE,
	BUILTIN_AGENT_APP_ID,
	BUILTIN_AGENT_MENTION_REF,
	MESSAGE_TYPE_URL,
	type MessageAttachment,
	type MessageDef,
	MessageRole,
	type RosterMember,
	type RosterRole,
	SenderKind,
} from "@brainstorm-os/sdk-types";
import { parseAttachments } from "@brainstorm-os/sdk/composer-context";
import { readPinned } from "./pins";
import { type ChannelProposal, readChannelProposal, readProposalPreview } from "./proposal";

/** The Chat-owned channel type (a channel is NOT an AI `Conversation/v1`, so
 *  it never collides with the Agent app's primary opener). */
export const CHANNEL_TYPE = "io.brainstorm.chat/Channel/v1";
/** Re-exported for the app + tests so the shared substrate id has one name. */
export const MESSAGE_TYPE = MESSAGE_TYPE_URL;

/** The `created_by` the shell stamps on rows it authors itself. Host-written —
 *  no app can set it — which is what makes it a usable trust signal here.
 *  Mirrors `SHELL_PRINCIPAL` in the main process's `agents/agent-record.ts`. */
export const SHELL_PRINCIPAL = "shell";

/** The minimal entity shape this module reads — a structural subset of the
 *  SDK `VaultEntity`, so helpers test against plain objects. */
export type EntityLike = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	/** The row's HOST-written `created_by` (the snapshot's `ownerAppId`). An app
	 *  cannot set it, so it is the only author claim on a message worth trusting
	 *  — `sender.personRef` is a self-assertion of whichever app wrote the row. */
	ownerAppId?: string;
};

export type ChatChannel = {
	id: string;
	name: string;
	topic: string;
	createdAt: string;
	/** Chats-4 — pinned message ids, oldest pin first (`logic/pins.ts`). */
	pinned: string[];
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
	/** The author's name AS THIS VIEWER SHOULD READ IT ({@link authorLabel}):
	 *  "You" for the local identity, otherwise the member's name or a neutral
	 *  fallback. Not the raw denormalised `sender.displayName`. */
	authorName: string;
	createdAt: string;
	seq: number;
	/** Context the author attached to the message (documents / people / media) —
	 *  rendered as chips; the persona-agent reading the channel grounds on them. */
	attachments: MessageAttachment[];
	/** Agent-Teams-3 — an agent's staged draft riding on this message, when the
	 *  row carries a well-formed one. Absent for every ordinary message AND for
	 *  a malformed proposal (fail-closed: it renders as an ordinary message). */
	proposal?: ChannelProposal;
	/** Agent-13 — the card is not this viewer's to decide: it was staged by
	 *  someone else's `@agent` invocation (or is only a synced preview of one).
	 *  It renders with its actions disabled and a line saying whose it is. */
	proposalReadOnly?: boolean;
	/** Agent-13 — set on a row that presents as the built-in agent: whether
	 *  this device's host vouches for it. Never derived from synced fields. */
	agentTrust?: AgentRowTrust;
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
		pinned: readPinned(entity.properties.pinned),
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

/** What builds up to 0.15 denormalised onto a message whose author had set no
 *  display name. It was written into the SYNCED row, so every other member's
 *  shell rendered that author as "You". Read as "no name" unless the row was
 *  authored under a per-device key, where it can only ever have meant the
 *  person looking at it. */
const LEGACY_UNNAMED_AUTHOR = "You";

/** The author key a single device minted before authorship moved to the
 *  sovereign pubkey (`mintPersonRef`). Never shared between people. */
const DEVICE_AUTHOR_PREFIX = "chat-person-";

/** How an author is named for THIS viewer. */
export type AuthorLabels = {
	/** This viewer's author key. "You" is only ever said about this key. */
	selfRef?: string;
	/** This viewer's own display name; "" when they have not set one. */
	selfName?: string;
	/** The localised "You". */
	you: string;
	/** The localised label for a member nothing else can name. */
	unnamed: string;
	/** A member's live display name by author key (the roster), if known. */
	nameOf?: (authorRef: string) => string | undefined;
};

/** A short, human-checkable form of an author key for a member with no name. */
export function shortAuthorRef(authorRef: string): string {
	return authorRef.length > 8 ? `${authorRef.slice(0, 6)}…` : authorRef;
}

/**
 * The name to show for a message's author. "You" is reserved for the local
 * identity: another member with no display name gets their roster name, else
 * a short form of their key, else the neutral "unknown member" - never "You".
 */
export function authorLabel(
	author: { authorRef: string; authorName: string },
	labels: AuthorLabels,
): string {
	if (labels.selfRef && author.authorRef === labels.selfRef) {
		return labels.selfName?.trim() || labels.you;
	}
	const live = labels.nameOf?.(author.authorRef)?.trim();
	if (live) return live;
	const stored = author.authorName.trim();
	const placeholder =
		stored === LEGACY_UNNAMED_AUTHOR && !author.authorRef.startsWith(DEVICE_AUTHOR_PREFIX);
	if (stored && !placeholder) return stored;
	return shortAuthorRef(author.authorRef) || labels.unnamed;
}

/** With no viewer context, nobody is "You": an unnamed author is their key. */
const ANONYMOUS_VIEWER: AuthorLabels = { you: "", unnamed: "" };

/** The author key + STORED name for a message: the `participant` sender's
 *  `personRef` / `displayName` when present, falling back to the entity id /
 *  "Someone" so a malformed sender never crashes the render. The stored name is
 *  what the author called themselves at send time and may be empty; it is
 *  turned into a label by {@link authorLabel}. */
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
		if (ref) return { authorRef: ref, authorName: str(s.displayName) };
	}
	return { authorRef: `anon:${fallbackId}`, authorName: "Someone" };
}

/**
 * The fingerprints of this vault's own agent members — the set a proposal card
 * must be authored by before it renders as an approvable card.
 *
 * The app-side mirror of main's `readTrustedAgentDef` notion, minus the crypto
 * half (an app has no key primitives; main re-checks the pubkey↔fingerprint
 * binding on every approve, and refuses otherwise). What this CAN check is the
 * half that decides honesty: the `Agent/v1` record must be SHELL-authored, so
 * an app-planted or synced-in record can never vouch for a card.
 */
export function trustedAgentAuthors(entities: readonly EntityLike[]): ReadonlySet<string> {
	const out = new Set<string>();
	for (const e of entities) {
		if (e.type !== AGENT_TYPE || e.ownerAppId !== SHELL_PRINCIPAL) continue;
		const fingerprint = str(e.properties.fingerprint);
		if (fingerprint) out.add(fingerprint);
	}
	return out;
}

/** Per-call context for {@link toMessage}. An options BAG rather than a
 *  positional set on purpose: `entities.map(toMessage)` hands the callback an
 *  index, and a bag degrades that to the fail-closed default instead of
 *  throwing (or, worse, treating an index as a trust set). */
export type ToMessageContext = {
	/** {@link trustedAgentAuthors} — the vault's own agent members. */
	trustedAgents?: ReadonlySet<string>;
	/** Agent-13 — this viewer's sovereign pubkey. A built-in-agent card is
	 *  decidable only when its invoker is this key; omit it and every such card
	 *  is read-only (fail-closed, like the trusted set). */
	selfPubkey?: string;
	/** How authors are named for this viewer. Omit it and no author is "You"
	 *  (an unnamed author renders as a short form of their key). */
	authorLabels?: AuthorLabels;
};

/** Agent-13 — how far a row that presents as the built-in agent is trusted. */
export enum AgentRowTrust {
	/** Written on THIS device by the Agent app (the host-written author says
	 *  so): the run happened here, for this device's own identity. */
	Vouched = "vouched",
	/** Everything about it is another member's synced data. It may well be
	 *  their agent's honest reply — nothing here can tell — so it is labelled
	 *  as shown from another device and never attributed to the real agent. */
	Unverified = "unverified",
}

/** The author key an UNVERIFIED agent-presenting row is filed under, so it can
 *  never share a header (or a colour) with the real agent's replies. */
export const UNVERIFIED_AGENT_REF = `unverified:${BUILTIN_AGENT_MENTION_REF}`;

function presentsAsBuiltinAgent(properties: Record<string, unknown>): boolean {
	const sender = properties.sender;
	return (
		!!sender &&
		typeof sender === "object" &&
		(sender as Record<string, unknown>).personRef === BUILTIN_AGENT_MENTION_REF
	);
}

/**
 * Agent-13 — classify a row that presents as the built-in agent, and resolve
 * its card.
 *
 * The ONLY trust signal is the host-written author. `sender`, `agentInvoker`
 * and the proposal preview are ordinary synced properties: any member of a
 * shared channel can write all three, so on their own they once painted a
 * convincing "Agent · asked by <victim> · approved" card. Now:
 *   · VOUCHED (author is this device's Agent app) — the card comes from the
 *     reserved `agentProposal` alone, decidable only by the invoker it names;
 *   · UNVERIFIED (anything else) — the synced preview renders read-only under
 *     an explicit "from another member's device, not verified" label, with no
 *     invoker name and no outcome stated as fact.
 */
function builtinAgentRow(
	entity: EntityLike,
	selfPubkey: string | undefined,
): { trust: AgentRowTrust; proposal: ChannelProposal | null; readOnly: boolean } | null {
	if (!presentsAsBuiltinAgent(entity.properties)) return null;
	if (entity.ownerAppId === BUILTIN_AGENT_APP_ID) {
		const proposal = readChannelProposal(entity.properties);
		const card = proposal?.invokedBy ? proposal : null;
		return {
			trust: AgentRowTrust.Vouched,
			proposal: card,
			readOnly: !!card && (!selfPubkey || card.invokedBy !== selfPubkey),
		};
	}
	return {
		trust: AgentRowTrust.Unverified,
		proposal: readProposalPreview(entity.properties),
		readOnly: true,
	};
}

/**
 * Project a message row. A proposal is attached ONLY when the row's
 * host-written author is one of `context.trustedAgents`.
 *
 * FAIL-CLOSED BY DEFAULT (Agent-Teams-3 closure b): omit the set and no card is
 * ever produced. A card is an approve button over a privileged main-side write,
 * and a card that arrived from ANOTHER vault can only ever fail there (inbound
 * rows never carry a local agent's fingerprint as `created_by`) — rendering the
 * button anyway is both a UX lie and a phishing surface. The parse itself stays
 * fail-closed too: a malformed card renders as an ordinary message, whose plain
 * body already reads honestly on its own.
 */
export function toMessage(entity: EntityLike, context?: ToMessageContext): ChatMessage {
	const author = readAuthor(entity.properties, entity.id);
	const richBody = str(entity.properties.richBody);
	const trusted = context?.trustedAgents;
	const teamProposal =
		trusted?.has(entity.ownerAppId ?? "") === true ? readChannelProposal(entity.properties) : null;
	const builtin = teamProposal ? null : builtinAgentRow(entity, context?.selfPubkey);
	const proposal = teamProposal ?? builtin?.proposal ?? null;
	const unverified = builtin?.trust === AgentRowTrust.Unverified;
	return {
		id: entity.id,
		channelId: str(entity.properties.conversation),
		body: str(entity.properties.body),
		...(richBody ? { richBody } : {}),
		authorRef: unverified ? UNVERIFIED_AGENT_REF : author.authorRef,
		authorName: authorLabel(author, context?.authorLabels ?? ANONYMOUS_VIEWER),
		createdAt: str(entity.properties.createdAt),
		seq: num(entity.properties.seq) ?? 0,
		attachments: parseAttachments(entity.properties.attachments),
		...(proposal ? { proposal } : {}),
		...(builtin?.readOnly ? { proposalReadOnly: true } : {}),
		...(builtin ? { agentTrust: builtin.trust } : {}),
	};
}

/** Order within a channel: monotonic `seq`, then wall-clock `createdAt`, then id
 *  — deterministic even when two devices stamp the same seq before converging. */
export function sortMessages(messages: readonly ChatMessage[]): ChatMessage[] {
	return [...messages].sort(
		(a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
	);
}

/** The ordered messages of one channel from the live snapshot. Resolves the
 *  trusted-agent author set from the same snapshot, so a proposal card only
 *  renders for a local agent's own message (see {@link toMessage}). */
export function channelMessages(
	entities: readonly EntityLike[],
	channelId: string,
	selfPubkey?: string,
	authorLabels?: AuthorLabels,
): ChatMessage[] {
	if (!channelId) return [];
	const trustedAgents = trustedAgentAuthors(entities);
	const rows = entities
		.filter((e) => e.type === MESSAGE_TYPE && str(e.properties.conversation) === channelId)
		.map((e) =>
			toMessage(e, {
				trustedAgents,
				...(selfPubkey ? { selfPubkey } : {}),
				...(authorLabels ? { authorLabels } : {}),
			}),
		);
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

/** `YYYY-MM-DD` of an ISO timestamp in the viewer's LOCAL calendar — the same
 *  zone the message time renders in, so a divider can never disagree with the
 *  stamps beneath it. An unparseable stamp is returned as-is. */
export function dayKey(iso: string): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return iso;
	const d = new Date(ms);
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${month}-${day}`;
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

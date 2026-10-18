import {
	CompactEditor,
	type CompactEditorHandle,
	type CompactEditorPayload,
	EntityIcon,
	type MentionComposerHandle,
	MentionComposerPlugin,
	MentionNode,
	renderEditorState,
} from "@brainstorm-os/editor";
import { useVaultEntities } from "@brainstorm-os/react-yjs";
import { openEntity } from "@brainstorm-os/sdk";
import {
	AttachmentKind,
	IconKind,
	type MessageAttachment,
	type RosterMember,
	RosterMemberKind,
} from "@brainstorm-os/sdk-types";
import {
	AttachContextButton,
	type ComposerContextHost,
	ComposerContextRail,
	type ComposerContextState,
	type ContextCandidate,
	MEDIA_BYTES_MAX,
	attachmentIcon,
	attachmentLabel,
	candidateToAttachment,
	pickFile,
	useComposerContext,
	useComposerObjectDrop,
	visibleAttachments,
	withMentionAttachments,
} from "@brainstorm-os/sdk/composer-context";
import { CountBadge, CountBadgeTone } from "@brainstorm-os/sdk/count-badge";
import { EmptyState } from "@brainstorm-os/sdk/empty-state";
import { parseIcon } from "@brainstorm-os/sdk/entity-icon";
import { resolveEntityTitle } from "@brainstorm-os/sdk/entity-title";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { MenuAlign, type SearchPickerItem, openSearchPicker } from "@brainstorm-os/sdk/menus";
import { closeObjectMenu, openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm-os/sdk/panel-toggle";
import { Popover } from "@brainstorm-os/sdk/popover";
import { PresenceStack, usePresence, useSelf } from "@brainstorm-os/sdk/presence-stack";
import { ShareDialog, type ShareDialogLabels } from "@brainstorm-os/sdk/share-dialog";
import { friendlyTypeName } from "@brainstorm-os/sdk/system-entities";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactElement } from "react";
import { formatDay, formatTime, navigatorLanguage } from "./format";
import { plural, t } from "./i18n";
import { useChatT } from "./i18n-hooks";
import {
	CHANNEL_TYPE,
	type ChatChannel,
	type ChatMessage,
	MESSAGE_TYPE,
	type PanelMember,
	authorColor,
	buildChannelProperties,
	buildMessageProperties,
	channelMessages,
	deriveChannels,
	groupMessages,
	initials,
	membersFromMessages,
	nextSeq,
	toPanelMembers,
} from "./logic/chat";
import { type LocalIdentity, mintPersonRef } from "./logic/identity";
import {
	ProposalDecision,
	ProposalDecisionFailure,
	type ProposalDecisionResult,
	readDecisionResult,
} from "./logic/proposal";
import { type SearchHit, SearchScope } from "./logic/search";
import { ackChannels, channelMaxSeqs, unreadByChannel } from "./logic/unread";
import { ProposalCard, type ProposalHost } from "./proposal-card";
import { getBrainstorm } from "./runtime";
import { SearchPanel } from "./search-panel";
import { ChatAction, useChatShortcut } from "./shortcuts";
import { useChatUserState } from "./use-user-state";
import "./styles.css";

const DEFAULT_NAME = "You";

/** Where the sovereign self (the synced read-state owner key) stands. */
enum SelfStatus {
	Pending = "pending",
	Resolved = "resolved",
	Failed = "failed",
}

const EMPTY_COMPOSER_DRAFT: CompactEditorPayload = { state: "", text: "", html: "", isEmpty: true };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const FLASH_MS = 2400;

/** A pending optimistic echo of a just-sent message, keyed so it can be dropped
 *  once the persisted twin arrives over the reactive snapshot. */
type Pending = { channelId: string; message: ChatMessage };

function shareDialogLabels(): ShareDialogLabels {
	return {
		title: t("share.title"),
		membersHeading: t("share.membersHeading"),
		you: t("share.you"),
		roleOwner: t("share.roleOwner"),
		roleEditor: t("share.roleEditor"),
		roleViewer: t("share.roleViewer"),
		revoke: t("share.revoke"),
		addHeading: t("share.addHeading"),
		codePlaceholder: t("share.codePlaceholder"),
		canEdit: t("share.canEdit"),
		canView: t("share.canView"),
		add: t("share.add"),
		quickAddHeading: t("share.quickAdd"),
		inviteHeading: t("share.inviteHeading"),
		getCode: t("share.getCode"),
		copy: t("share.copy"),
		copied: t("share.copied"),
		inviteHint: t("share.inviteHint"),
		shareFailed: t("share.shareFailed"),
		revokeFailed: t("share.revokeFailed"),
		loadFailed: t("share.loadFailed"),
		done: t("share.done"),
	};
}

export function ChatApp(): ReactElement {
	useChatT();
	const services = getBrainstorm()?.services ?? null;
	const vaultEntities = services?.vaultEntities ?? null;
	const entitiesSvc = services?.entities ?? null;
	const storage = services?.storage ?? null;
	const roster = services?.roster ?? null;

	const { entities } = useVaultEntities(vaultEntities);

	const channels = useMemo(() => deriveChannels(entities), [entities]);

	// Declared up here (ahead of the composer host) so the @-mention search can
	// scope its roster lookup to the active channel.
	const [activeId, setActiveId] = useState<string | null>(null);

	// Composer context — `@`-mentions commit as INLINE chips in the draft (Slack
	// model; the send path lifts them into wire attachments for the notifier),
	// while linked documents / uploaded media ride the visible rail. `@` is
	// scoped to PEOPLE so the typeahead never mixes persons and documents in one
	// list; documents are pinned through their own affordance (`linkDocument`
	// below). Search runs over the live snapshot (the app holds
	// `entities.read:*`); media uploads through `storage.uploadFile` (`storage.kv`).
	const attachments = useComposerContext();
	const contextHost = useMemo<ComposerContextHost>(
		() => ({
			searchCandidates: async (query: string) => {
				const q = query.trim().toLowerCase();
				const matches: ContextCandidate[] = [];
				// People come from the channel roster (Collab-C6) — actual vault
				// members, keyed on the sovereign pubkey so the mention resolves to a
				// real identity, not an arbitrary Person/v1 contact. The stored
				// attachment `ref` is the pubkey; the `label` denormalises the name so
				// a recipient who hasn't cached the profile still sees a name.
				if (!roster || !activeId) return matches;
				try {
					// Agent-Teams-3 — the vault's agent members ride the same list
					// (kind-tagged), so "@Researcher" works exactly like "@Ada":
					// mentioning an agent invites its loop into the channel.
					const people = await roster.members(activeId, { includeAgents: true });
					for (const m of people) {
						const name = m.displayName || m.fingerprint;
						if (q && !name.toLowerCase().includes(q)) continue;
						const isAgent = m.kind === RosterMemberKind.Agent;
						matches.push({
							id: m.pubkey,
							kind: AttachmentKind.Person,
							label: name,
							description: m.isSelf ? t("members.you") : isAgent ? t("members.agent") : m.fingerprint,
						});
						if (matches.length >= 8) break;
					}
				} catch (err) {
					console.warn("[chat] mention roster load failed:", err);
				}
				return matches;
			},
		}),
		[roster, activeId],
	);

	// Documents / objects are pinned through their own search picker (anchored to
	// the composer's "+" button) — deliberately NOT the `@` typeahead, so people
	// and documents never share one list.
	const linkDocument = useCallback(
		(anchor: Element) => {
			openSearchPicker({
				placeholder: t("composer.attach.linkDocument.placeholder"),
				ariaLabel: t("composer.attach.linkDocument.aria"),
				anchor,
				filter: (query: string): readonly SearchPickerItem[] => {
					const q = query.trim().toLowerCase();
					const rows: SearchPickerItem[] = [];
					for (const e of entities) {
						if (rows.length >= 12) break;
						if (e.type === CHANNEL_TYPE || e.type === MESSAGE_TYPE) continue;
						if (e.type.endsWith("/Person/v1")) continue;
						const title = resolveEntityTitle(e.properties) ?? "";
						if (!title) continue;
						if (q && !title.toLowerCase().includes(q)) continue;
						rows.push({ id: e.id, label: title, caption: friendlyTypeName(e.type) });
					}
					if (rows.length === 0) {
						return [{ id: "__empty", label: t("composer.attach.linkDocument.empty"), disabled: true }];
					}
					return rows;
				},
				onSelect: (id: string) => {
					const e = entities.find((x) => x.id === id);
					if (!e) return;
					attachments.add(
						candidateToAttachment({
							id: e.id,
							kind: AttachmentKind.Entity,
							label: resolveEntityTitle(e.properties) ?? "",
							entityType: e.type,
							description: friendlyTypeName(e.type),
						}),
					);
				},
			});
		},
		[entities, attachments],
	);
	const uploadMedia = useCallback(async () => {
		if (!storage?.uploadFile) return;
		const file = await pickFile();
		if (!file) return;
		if (file.size > MEDIA_BYTES_MAX) {
			console.warn("[chat] media too large to attach:", file.name, file.size);
			return;
		}
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const mime = file.type || "application/octet-stream";
			const uploaded = await storage.uploadFile(file.name, bytes, mime);
			attachments.add({
				kind: AttachmentKind.Media,
				ref: uploaded.url,
				mediaType: mime,
				label: file.name,
				...(mime.startsWith("image/") ? { image: true } : {}),
				bytes: uploaded.size,
			});
		} catch (err) {
			console.warn("[chat] media upload failed:", err);
		}
	}, [storage, attachments]);

	const [pending, setPending] = useState<Pending[]>([]);
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchScope, setSearchScope] = useState<SearchScope>(SearchScope.Channel);
	const [highlight, setHighlight] = useState<{ messageId: string; nonce: number } | null>(null);
	const [showSidebar, setShowSidebar] = useState(true);
	const [showMembers, setShowMembers] = useState(false);
	const [composeNew, setComposeNew] = useState(false);
	const [editIdentity, setEditIdentity] = useState(false);
	// The seed is minted once and reused for BOTH the synchronous local identity
	// and the persisted load below — `mintPersonRef` is deterministic, so the
	// in-memory key and the first-run persisted key are identical.
	const seedRef = useRef<string | null>(null);
	if (seedRef.current === null) {
		seedRef.current = `${navigatorLanguage()}|${Date.now()}|${Math.random()}`;
	}
	// Mint the author key synchronously so a message can be sent the instant the
	// composer is ready. Without this the `personRef` is empty until the storage
	// round-trip resolves, and any send before then silently no-ops (the bug:
	// type-and-send on open does nothing). The persisted identity replaces this
	// once storage loads.
	const [identity, setIdentity] = useState<LocalIdentity>(() => ({
		personRef: mintPersonRef(seedRef.current ?? ""),
		displayName: DEFAULT_NAME,
	}));

	// Resolve the author identity from the vault's self-asserted profile (Collab-C6):
	// the durable author key is the sovereign pubkey, the name is the signed
	// `Profile/v1` displayName. This replaces the per-device personRef — the same
	// author now reads consistently across every device. The synchronous
	// `mintPersonRef` fallback above keeps send working for the brief window before
	// this resolves (an older personRef-authored message still renders via its
	// denormalised name, just unlinked from the live roster).
	const [selfStatus, setSelfStatus] = useState<SelfStatus>(SelfStatus.Pending);
	useEffect(() => {
		if (!roster) return;
		let live = true;
		roster
			.self()
			.then((self) => {
				if (!live) return;
				setIdentity({
					personRef: self.pubkey,
					displayName: self.displayName || DEFAULT_NAME,
					...(self.avatarRef ? { avatarRef: self.avatarRef } : {}),
				});
				setSelfStatus(SelfStatus.Resolved);
			})
			.catch((err) => {
				console.warn("[chat] profile load failed; using local identity", err);
				if (live) setSelfStatus(SelfStatus.Failed);
			});
		return () => {
			live = false;
		};
	}, [roster]);

	// Default the selection to the first channel once one exists.
	useEffect(() => {
		if (activeId === null && channels.length > 0) {
			setActiveId(channels[0]?.id ?? null);
		}
	}, [activeId, channels]);

	const activeChannel = channels.find((c) => c.id === activeId) ?? null;

	// PRES-3 — who's-here on the open channel (live avatars, distinct from the
	// channel MEMBER roster). Cross-device in the shell; empty otherwise.
	const channelPeers = usePresence(activeChannel?.id ?? null, CHANNEL_TYPE, useSelf());

	// ── 7.14 — the app-icon unread badge. Seen semantics are app-owned: the
	// ACTIVE channel is continuously read (you're looking at it); a channel
	// observed for the first time baselines at its current max seq (history
	// never badges on first run); everything else counts others' messages
	// above the per-channel watermark. Chats-2: the watermarks follow the user
	// on a synced per-user entity (`use-user-state.ts`), migrated once from the
	// old device-local kv key; nothing acks until they're known, so a premature
	// 0 never clears a live badge.
	const userState = useChatUserState({
		entities,
		entitiesSvc,
		storage,
		canSync: !!roster && selfStatus !== SelfStatus.Failed,
		ownerRef: selfStatus === SelfStatus.Resolved ? identity.personRef : "",
	});
	const { ready: marksReady, watermarks, raiseWatermarks, prefs, setPrefs } = userState;
	const [composerExpanded, setComposerExpanded] = useState(false);
	useChatShortcut(ChatAction.ToggleComposer, () => setComposerExpanded((v) => !v), {
		enabled: !!activeId,
	});

	useEffect(() => {
		if (!marksReady) return;
		const maxes = channelMaxSeqs(entities);
		const toAck = [...maxes.keys()].filter((id) => watermarks[id] === undefined);
		if (activeId !== null) toAck.push(activeId);
		const next = ackChannels(watermarks, maxes, toAck);
		if (next !== watermarks) raiseWatermarks(next);
	}, [marksReady, watermarks, entities, activeId, raiseWatermarks]);

	const unreadCounts = useMemo(
		() =>
			marksReady
				? unreadByChannel(entities, identity.personRef, watermarks)
				: new Map<string, number>(),
		[marksReady, entities, identity.personRef, watermarks],
	);
	const unread = useMemo(() => {
		let total = 0;
		for (const n of unreadCounts.values()) total += n;
		return total;
	}, [unreadCounts]);

	const markRead = useCallback(
		(channelIds: readonly string[]) => {
			if (!marksReady) return;
			const next = ackChannels(watermarks, channelMaxSeqs(entities), channelIds);
			if (next !== watermarks) raiseWatermarks(next);
		},
		[marksReady, watermarks, entities, raiseWatermarks],
	);
	const markAllRead = useCallback(() => markRead(channels.map((c) => c.id)), [markRead, channels]);
	useChatShortcut(ChatAction.MarkAllRead, markAllRead);

	// Mirror the unread count onto the dashboard app-icon badge (cap
	// `ui.badge`; the Mailbox pattern). `set({count})` treats count<=0 as a
	// clear, so draining to all-read clears the chip. Keyed on the derived
	// count; fire-and-forget and a no-op on shells without the badge service.
	useEffect(() => {
		if (!marksReady) return;
		const badge = services?.ui?.badge;
		if (!badge) return;
		void badge.set({ count: unread }).catch(() => undefined);
	}, [unread, marksReady, services]);

	const persisted = useMemo(
		() => (activeId ? channelMessages(entities, activeId) : []),
		[entities, activeId],
	);

	// Merge persisted messages with this channel's optimistic echoes, dropping an
	// echo once its persisted twin (same author + seq) has converged.
	const messages = useMemo<ChatMessage[]>(() => {
		const echoes = pending.filter(
			(p) =>
				p.channelId === activeId &&
				!persisted.some((m) => m.authorRef === p.message.authorRef && m.seq === p.message.seq),
		);
		return [...persisted, ...echoes.map((p) => p.message)];
	}, [persisted, pending, activeId]);

	// Drop echoes whose persisted twin has arrived (keeps `pending` from growing).
	useEffect(() => {
		setPending((prev) =>
			prev.filter(
				(p) =>
					!(
						activeId &&
						p.channelId === activeId &&
						persisted.some((m) => m.authorRef === p.message.authorRef && m.seq === p.message.seq)
					),
			),
		);
	}, [persisted, activeId]);

	const groups = useMemo(() => groupMessages(messages, authorColor), [messages]);

	// The authoritative member roster (the channel's signed access record, resolved
	// to display profiles). Refetched when the channel changes (membership shifts
	// with the access record, not with posts). Merged with the message-derived
	// authors below so a legacy poster still shows as a guest — that merge is the
	// reactive-to-messages half, via the `members` memo.
	const [rosterMembers, setRosterMembers] = useState<RosterMember[]>([]);
	useEffect(() => {
		if (!roster || !activeId) {
			setRosterMembers([]);
			return;
		}
		let live = true;
		roster
			.members(activeId)
			.then((m) => {
				if (live) setRosterMembers(m);
			})
			.catch((err) => {
				console.warn("[chat] roster load failed:", err);
				if (live) setRosterMembers([]);
			});
		return () => {
			live = false;
		};
	}, [roster, activeId]);

	const members = useMemo<PanelMember[]>(
		() =>
			toPanelMembers({
				roster: rosterMembers,
				messageMembers: membersFromMessages(messages, authorColor),
				colorFor: authorColor,
			}),
		[rosterMembers, messages],
	);

	// Avatar lookup for message headers, keyed by author key (the sovereign pubkey
	// === a message's `authorRef`). The member roster carries each author's signed
	// `avatarRef`; self's optimistic avatar is layered on so it shows before the
	// roster refetch lands. Legacy guests have no entry and fall back to initials.
	const avatarByAuthor = useMemo(() => {
		const map = new Map<string, string>();
		for (const m of members) if (m.avatarRef) map.set(m.key, m.avatarRef);
		if (identity.avatarRef) map.set(identity.personRef, identity.avatarRef);
		return map;
	}, [members, identity.personRef, identity.avatarRef]);

	// Agent-Teams-3 — the approve/discard surface for an agent's proposal card.
	// The decision is a PRIVILEGED main-side write (`agents.approve`): the app
	// only asks for it, and never asserts either half of the provenance. Failure
	// is normalised — the card must always be able to say something truthful, so
	// a throw or an absent service becomes `Unavailable` rather than a silence.
	const proposalsSvc = services?.agentProposals ?? null;
	const intentsSvc = services?.intents ?? null;
	const proposalHost = useMemo<ProposalHost>(
		() => ({
			canDecide: !!proposalsSvc,
			decide: async (messageId, decision): Promise<ProposalDecisionResult> => {
				if (!proposalsSvc) return { ok: false, reason: ProposalDecisionFailure.Unavailable };
				try {
					const reply =
						decision === ProposalDecision.Approve
							? await proposalsSvc.approve({ messageId })
							: await proposalsSvc.discard({ messageId });
					return readDecisionResult(reply);
				} catch (err) {
					console.warn("[chat] proposal decision failed:", err);
					return { ok: false, reason: ProposalDecisionFailure.Unavailable };
				}
			},
			open: (entityId, entityType) => {
				if (!intentsSvc || !entityId) return;
				void openEntity(
					{
						services: {
							intents: {
								dispatch: (intent) =>
									intentsSvc.dispatch(intent as Parameters<typeof intentsSvc.dispatch>[0]),
							},
						},
					},
					{ entityId, entityType },
				);
			},
		}),
		[proposalsSvc, intentsSvc],
	);

	const createChannel = useCallback(
		async (name: string, topic: string) => {
			if (!entitiesSvc) return;
			const created = await entitiesSvc.create(
				CHANNEL_TYPE,
				buildChannelProperties({ name, topic, createdAt: new Date().toISOString() }),
			);
			setActiveId(created.id);
			setComposeNew(false);
		},
		[entitiesSvc],
	);

	const sendMessage = useCallback(
		async (body: string, richBody: string, atts: readonly MessageAttachment[]) => {
			const text = body.trim();
			if ((!text && atts.length === 0) || !entitiesSvc || !activeId || !identity.personRef) return;
			// Only carry the rich body when there's actual text — an attachments-only
			// message has no rich content to serialize.
			const rich = text ? richBody : "";
			// Inline `@`-mention chips ride in the rich body; lift them into Person
			// attachments too so the mention-notifier sees them (they render inline,
			// not as chips — `visibleAttachments`).
			const allAtts = withMentionAttachments(rich || undefined, atts);
			const now = new Date().toISOString();
			const seq = nextSeq(messages);
			const echo: ChatMessage = {
				id: `pending-${now}-${seq}`,
				channelId: activeId,
				body: text,
				...(rich ? { richBody: rich } : {}),
				authorRef: identity.personRef,
				authorName: identity.displayName,
				createdAt: now,
				seq,
				attachments: allAtts,
			};
			setPending((prev) => [...prev, { channelId: activeId, message: echo }]);
			attachments.clear();
			try {
				await entitiesSvc.create(
					MESSAGE_TYPE,
					buildMessageProperties({
						channelId: activeId,
						body: text,
						...(rich ? { richBody: rich } : {}),
						authorRef: identity.personRef,
						authorName: identity.displayName,
						createdAt: now,
						seq,
						...(allAtts.length > 0 ? { attachments: allAtts } : {}),
					}),
				);
			} catch (err) {
				console.warn("[chat] failed to send message:", err);
				setPending((prev) => prev.filter((p) => p.message.id !== echo.id));
			}
		},
		[entitiesSvc, activeId, identity, messages, attachments],
	);

	const persistName = useCallback(
		async (raw: string) => {
			setEditIdentity(false);
			const name = raw.trim();
			if (!name) return;
			// Optimistic local update; the signed `Profile/v1` is the source of truth.
			setIdentity((prev) => ({ ...prev, displayName: name }));
			if (!roster) return;
			try {
				// Carry the current avatarRef through — `setSelf` rewrites the signed
				// profile wholesale, so omitting it would clear the avatar set in
				// Settings (the profile-store treats absent avatarRef as "cleared").
				const saved = await roster.setSelf({
					displayName: name,
					...(identity.avatarRef ? { avatarRef: identity.avatarRef } : {}),
				});
				setIdentity((prev) => ({
					personRef: prev.personRef,
					displayName: saved.displayName || DEFAULT_NAME,
					...(saved.avatarRef ? { avatarRef: saved.avatarRef } : {}),
				}));
				// Refresh the panel so the self row picks up the new name immediately.
				if (activeId) setRosterMembers(await roster.members(activeId));
			} catch (err) {
				console.warn("[chat] failed to save profile name:", err);
			}
		},
		[roster, activeId, identity.avatarRef],
	);

	const openSearch = useCallback(
		(scope: SearchScope) => {
			setSearchScope(activeId ? scope : SearchScope.All);
			setSearchOpen(true);
		},
		[activeId],
	);
	useChatShortcut(ChatAction.Search, () => openSearch(SearchScope.Channel));
	useChatShortcut(ChatAction.SearchAll, () => openSearch(SearchScope.All));
	const jumpToHit = useCallback((hit: SearchHit) => {
		setActiveId(hit.channelId);
		setHighlight((prev) => ({ messageId: hit.messageId, nonce: (prev?.nonce ?? 0) + 1 }));
	}, []);

	const moreRef = useRef<HTMLButtonElement>(null);
	const [shareOpen, setShareOpen] = useState(false);
	useEffect(() => closeObjectMenu, []);
	const canShare = !!activeChannel && !!services?.sharing && !!roster;
	const openMore = useCallback(() => {
		const el = moreRef.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		openAnchoredMenu(
			{ x: r.right, y: r.bottom + 4 },
			[
				{
					label: t("sidebar.newChannel"),
					icon: IconName.Plus,
					onSelect: () => setComposeNew(true),
				},
				{
					label: t("menu.markAllRead"),
					icon: IconName.Read,
					disabled: unread === 0,
					onSelect: markAllRead,
				},
				{
					label: t("menu.absoluteTimestamps"),
					selected: prefs.absoluteTimestamps,
					onSelect: () => setPrefs({ absoluteTimestamps: !prefs.absoluteTimestamps }),
				},
				...(canShare
					? [
							{
								label: t("menu.share"),
								icon: IconName.OpenExternal,
								onSelect: () => setShareOpen(true),
							},
						]
					: []),
				{
					label: t("menu.editIdentity"),
					icon: IconName.Pencil,
					onSelect: () => setEditIdentity(true),
				},
			],
			{ menuLabel: t("header.moreActions"), anchor: el, align: MenuAlign.End },
		);
	}, [canShare, unread, markAllRead, prefs.absoluteTimestamps, setPrefs]);

	return (
		<div
			className="app chat"
			data-sidebar-open={String(showSidebar)}
			data-members-open={String(showMembers && !!activeChannel)}
		>
			<header className="app-header" data-testid="app-header">
				<div className="app-header__left">
					<h1 className="app-header__title">{t("app.title")}</h1>
					{activeChannel ? (
						<span className="chat__crumb" data-testid="active-channel">
							<span className="chat__crumb-hash" aria-hidden="true">
								#
							</span>
							{activeChannel.name}
							{activeChannel.topic ? (
								<span className="chat__crumb-topic">{activeChannel.topic}</span>
							) : null}
						</span>
					) : null}
				</div>
				<div className="app-header__right">
					{channelPeers.length > 0 && <PresenceStack peers={channelPeers} />}
					<button
						type="button"
						className="chat__icon-btn"
						data-bs-tooltip={t("search.open")}
						aria-label={t("search.open")}
						aria-pressed={searchOpen}
						onClick={() => (searchOpen ? setSearchOpen(false) : openSearch(SearchScope.Channel))}
						data-testid="search-toggle"
					>
						<Icon name={IconName.Search} size={18} />
					</button>
					<PanelToggleButton
						side={PanelSide.Left}
						open={showSidebar}
						onClick={() => setShowSidebar((v) => !v)}
						labels={{ show: t("sidebar.show"), hide: t("sidebar.hide") }}
						testId="sidebar-toggle"
					/>
					<PanelToggleButton
						side={PanelSide.Right}
						open={showMembers && !!activeChannel}
						onClick={() => setShowMembers((v) => !v)}
						labels={{ show: t("header.members.show"), hide: t("header.members.hide") }}
						disabled={!activeChannel}
						{...(activeChannel ? {} : { hint: t("header.members.disabled") })}
						testId="members-toggle"
					/>
					<button
						ref={moreRef}
						type="button"
						className="chat__icon-btn bs-object-menu__more"
						data-bs-tooltip={t("header.moreActions")}
						aria-label={t("header.moreActions")}
						aria-haspopup="menu"
						onClick={openMore}
					>
						<Icon name={IconName.More} size={18} />
					</button>
				</div>
			</header>

			<div className="chat__body">
				<ChannelSidebar
					open={showSidebar}
					channels={channels}
					activeId={activeId}
					unreadCounts={unreadCounts}
					onSelect={setActiveId}
					onNew={() => setComposeNew(true)}
					onMarkRead={(id) => markRead([id])}
					onMarkAllRead={markAllRead}
				/>

				<main className="chat__main">
					{searchOpen ? (
						<SearchPanel
							entities={entities}
							activeChannelId={activeChannel?.id ?? null}
							activeChannelName={activeChannel?.name ?? null}
							query={searchQuery}
							scope={searchScope}
							onQueryChange={setSearchQuery}
							onScopeChange={setSearchScope}
							onSelect={jumpToHit}
							onClose={() => setSearchOpen(false)}
						/>
					) : null}
					{activeChannel ? (
						<>
							<MessageView
								channel={activeChannel}
								groups={groups}
								avatarByAuthor={avatarByAuthor}
								emptyName={activeChannel.name}
								proposalHost={proposalHost}
								highlight={highlight}
								absoluteTimestamps={prefs.absoluteTimestamps}
							/>
							<Composer
								expanded={composerExpanded}
								onToggleExpanded={() => setComposerExpanded((v) => !v)}
								channelName={activeChannel.name}
								onSend={sendMessage}
								disabled={!entitiesSvc}
								host={contextHost}
								attachments={attachments}
								onLinkDocument={linkDocument}
								{...(storage?.uploadFile ? { onUploadMedia: uploadMedia } : {})}
							/>
						</>
					) : (
						<div className="chat__placeholder" data-testid="no-channel">
							<EmptyState
								icon={IconName.Chat}
								title={t("channel.none.title")}
								hint={t("channel.none.blurb")}
								action={
									<button
										type="button"
										className="bs-btn"
										data-bs-primary=""
										onClick={() => setComposeNew(true)}
									>
										{t("sidebar.newChannel")}
									</button>
								}
							/>
						</div>
					)}
				</main>

				<MembersPanel
					open={showMembers && !!activeChannel}
					members={members}
					onEditIdentity={() => setEditIdentity(true)}
				/>
			</div>

			{composeNew ? (
				<NewChannelPopover onClose={() => setComposeNew(false)} onCreate={createChannel} />
			) : null}
			{editIdentity ? (
				<IdentityPopover
					current={identity.displayName}
					onClose={() => setEditIdentity(false)}
					onSave={persistName}
				/>
			) : null}
			{shareOpen && activeChannel && services?.sharing && roster ? (
				<ShareDialog
					entityId={activeChannel.id}
					entityType={CHANNEL_TYPE}
					collection
					sharing={services.sharing}
					roster={roster}
					canManage
					labels={shareDialogLabels()}
					onClose={() => setShareOpen(false)}
				/>
			) : null}
		</div>
	);
}

// ───────────────────────────── sidebar ─────────────────────────────

function ChannelSidebar({
	open,
	channels,
	activeId,
	unreadCounts,
	onSelect,
	onNew,
	onMarkRead,
	onMarkAllRead,
}: {
	/** The CSS guard lands only at the END of the 180ms slide (F-489); `inert`
	 *  removes the panel from the tab order and the a11y tree immediately. */
	open: boolean;
	channels: readonly ChatChannel[];
	activeId: string | null;
	unreadCounts: ReadonlyMap<string, number>;
	onSelect: (id: string) => void;
	onNew: () => void;
	onMarkRead: (channelId: string) => void;
	onMarkAllRead: () => void;
}): ReactElement {
	const anyUnread = unreadCounts.size > 0;
	const openChannelMenu = (event: MouseEvent, channelId: string): void => {
		event.preventDefault();
		openAnchoredMenu(
			{ x: event.clientX, y: event.clientY },
			[
				{
					label: t("menu.markRead"),
					icon: IconName.Read,
					disabled: !unreadCounts.has(channelId),
					onSelect: () => onMarkRead(channelId),
				},
				{
					label: t("menu.markAllRead"),
					icon: IconName.Read,
					disabled: !anyUnread,
					onSelect: onMarkAllRead,
				},
			],
			{ menuLabel: t("sidebar.channelMenu") },
		);
	};
	return (
		<nav
			className="chat__sidebar"
			aria-label={t("sidebar.channels")}
			aria-hidden={open ? undefined : true}
			inert={open ? undefined : true}
		>
			<div className="chat__sidebar-header">
				<span className="chat__sidebar-title">{t("sidebar.channels")}</span>
				<button
					type="button"
					className="chat__icon-btn"
					data-bs-tooltip={t("sidebar.newChannel")}
					aria-label={t("sidebar.newChannel")}
					onClick={onNew}
				>
					<Icon name={IconName.Plus} size={16} />
				</button>
			</div>
			{channels.length === 0 ? (
				<p className="chat__sidebar-empty">{t("sidebar.empty")}</p>
			) : (
				<ul className="chat__channel-list">
					{channels.map((c) => {
						const count = unreadCounts.get(c.id) ?? 0;
						const active = c.id === activeId;
						return (
							<li key={c.id}>
								<button
									type="button"
									className={`chat__channel${active ? " chat__channel--active" : ""}${count > 0 ? " chat__channel--unread" : ""}`}
									aria-current={active ? "true" : undefined}
									aria-label={
										count > 0
											? plural(count, "sidebar.channelUnread.one", "sidebar.channelUnread.other", {
													name: c.name,
												})
											: undefined
									}
									onClick={() => onSelect(c.id)}
									onContextMenu={(e) => openChannelMenu(e.nativeEvent, c.id)}
								>
									<span className="chat__channel-hash" aria-hidden="true">
										#
									</span>
									<span className="chat__channel-name">{c.name}</span>
									{count > 0 ? (
										<CountBadge
											count={count}
											max={99}
											tone={active ? CountBadgeTone.Accent : CountBadgeTone.Neutral}
											className="chat__channel-badge"
										/>
									) : null}
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</nav>
	);
}

// ───────────────────────────── messages ─────────────────────────────

function Avatar({
	name,
	color,
	avatarRef,
	size = 34,
}: {
	name: string;
	color: string;
	avatarRef?: string;
	/** The host circle's diameter — must match the CSS size of the slot the
	 *  avatar renders in (34 message gutter, 26 member row). */
	size?: number;
}): ReactElement {
	const icon = useMemo(() => {
		if (!avatarRef) return null;
		try {
			return parseIcon(JSON.parse(avatarRef));
		} catch {
			return null;
		}
	}, [avatarRef]);
	if (icon) {
		// A photo fills the circle edge-to-edge (the host's radius + overflow
		// clip it round); a glyph (emoji / pack) stays centered with breathing
		// room — sizing it to the circle would crop the glyph's edges.
		const image = icon.kind === IconKind.Image;
		return (
			<span className="chat__avatar chat__avatar--icon" aria-hidden="true">
				<EntityIcon icon={icon} size={image ? size : Math.round(size * 0.8)} />
			</span>
		);
	}
	return (
		<span className="chat__avatar" style={{ background: color }} aria-hidden="true">
			{initials(name)}
		</span>
	);
}

function MessageView({
	channel,
	groups,
	avatarByAuthor,
	emptyName,
	proposalHost,
	highlight,
	absoluteTimestamps,
}: {
	channel: ChatChannel;
	groups: ReturnType<typeof groupMessages>;
	avatarByAuthor: ReadonlyMap<string, string>;
	emptyName: string;
	proposalHost: ProposalHost;
	/** Chats-1 — a search jump target; `nonce` re-fires a repeat pick. */
	highlight: { messageId: string; nonce: number } | null;
	/** Chats-3 — full date + time instead of Today / Yesterday + clock. */
	absoluteTimestamps: boolean;
}): ReactElement {
	const scrollRef = useRef<HTMLDivElement>(null);
	const count = groups.reduce((n, g) => n + g.messages.length, 0);
	// Pin to the latest message as the transcript grows. `count` both gates the
	// no-op on an empty transcript and is the re-run trigger as messages arrive.
	useEffect(() => {
		if (count === 0) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [count]);

	// Declared after the pin-to-latest effect so a jump that also switched
	// channels lands on the hit, not the bottom.
	const [flashId, setFlashId] = useState<string | null>(null);
	const targetId = highlight?.messageId ?? null;
	const targetNonce = highlight?.nonce ?? 0;
	useEffect(() => {
		if (!targetId || targetNonce === 0 || !channel.id) return;
		const host = scrollRef.current;
		const el = [...(host?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])].find(
			(node) => node.dataset.messageId === targetId,
		);
		if (!el) return;
		el.scrollIntoView?.({ block: "center" });
		setFlashId(targetId);
		const timer = setTimeout(() => setFlashId(null), FLASH_MS);
		return () => clearTimeout(timer);
	}, [targetId, targetNonce, channel.id]);

	if (groups.length === 0) {
		return (
			<div className="chat__messages chat__messages--empty" ref={scrollRef} data-testid="messages">
				<EmptyState
					icon={IconName.Chat}
					title={t("channel.empty.title")}
					hint={t("channel.empty.blurb", { name: emptyName })}
				/>
			</div>
		);
	}

	let lastDay = "";
	return (
		<div className="chat__messages" ref={scrollRef} data-testid="messages">
			{groups.map((g, i) => {
				const showDivider = g.dayKey !== lastDay;
				lastDay = g.dayKey;
				const first = g.messages[0];
				const avatarRef = avatarByAuthor.get(g.authorRef);
				return (
					<div key={`${channel.id}-${first?.id ?? i}`}>
						{showDivider ? <DayDivider dayKey={g.dayKey} absolute={absoluteTimestamps} /> : null}
						<article className="chat__group">
							<Avatar name={g.authorName} color={g.color} {...(avatarRef ? { avatarRef } : {})} />
							<div className="chat__group-body">
								<header className="chat__group-head">
									<span className="chat__author" style={{ color: g.color }}>
										{g.authorName}
									</span>
									<time className="chat__time" dateTime={first?.createdAt}>
										{formatTime(first?.createdAt ?? "", absoluteTimestamps)}
									</time>
								</header>
								{g.messages.map((m) => {
									const chips = visibleAttachments(m);
									return (
										<div
											key={m.id}
											className={`chat__line-wrap${m.id === flashId ? " chat__line-wrap--flash" : ""}`}
											data-message-id={m.id}
										>
											{m.richBody ? (
												<div className="chat__line chat__line--rich bs-editor bs-editor--readonly">
													{renderEditorState(m.richBody)}
												</div>
											) : m.body ? (
												<p className="chat__line">{m.body}</p>
											) : null}
											{m.proposal ? (
												<ProposalCard messageId={m.id} proposal={m.proposal} host={proposalHost} />
											) : null}
											{chips.length > 0 ? (
												<div className="chat__attachments" data-testid="message-attachments">
													{chips.map((a) => (
														<span key={a.ref} className="chat__attachment" data-kind={a.kind}>
															<Icon name={attachmentIcon(a.kind)} size={12} />
															{attachmentLabel(a)}
														</span>
													))}
												</div>
											) : null}
										</div>
									);
								})}
							</div>
						</article>
					</div>
				);
			})}
		</div>
	);
}

function DayDivider({ dayKey, absolute }: { dayKey: string; absolute: boolean }): ReactElement {
	return (
		<div className="chat__day">
			<span className="chat__day-label">{formatDay(dayKey, absolute)}</span>
		</div>
	);
}

// ───────────────────────────── composer ─────────────────────────────

function Composer({
	expanded,
	onToggleExpanded,
	channelName,
	onSend,
	disabled,
	host,
	attachments,
	onLinkDocument,
	onUploadMedia,
}: {
	/** Chats-3 — the taller drafting mode (`chat.toggle-composer`). */
	expanded: boolean;
	onToggleExpanded: () => void;
	channelName: string;
	onSend: (body: string, richBody: string, atts: readonly MessageAttachment[]) => void;
	disabled: boolean;
	host: ComposerContextHost;
	attachments: ComposerContextState;
	onLinkDocument: (anchor: Element) => void;
	onUploadMedia?: () => void;
}): ReactElement {
	const editorRef = useRef<CompactEditorHandle>(null);
	const mentionRef = useRef<MentionComposerHandle>(null);
	const draftRef = useRef<CompactEditorPayload>(EMPTY_COMPOSER_DRAFT);
	const [draftEmpty, setDraftEmpty] = useState(true);
	// DND-4: drop an object onto the composer to pin it as context — the same
	// result as "Link a document…", by direct manipulation (both transports).
	const objectDrop = useComposerObjectDrop(attachments);

	// Enter (CompactEditor `onSubmit`) and the Send button both route here. The
	// rich body rides only when there's text; an attachments-only message sends
	// with an empty body. CompactEditor + attachments clear on a successful send.
	const commit = (payload: CompactEditorPayload): void => {
		const text = payload.text.trim();
		if (!text && attachments.attachments.length === 0) return;
		onSend(text, payload.state, attachments.attachments);
		editorRef.current?.clear();
	};

	const placeholder = t("composer.placeholder", { name: channelName });
	return (
		<div
			className={`chat__composer-wrap${objectDrop.isOver ? " chat__composer-wrap--drop" : ""}${expanded ? " chat__composer-wrap--expanded" : ""}`}
			data-testid="composer"
			{...objectDrop.dropProps}
		>
			<ComposerContextRail
				attachments={attachments.attachments}
				onRemove={attachments.remove}
				removeLabel={(label) => t("composer.attach.remove", { label })}
			/>
			<div className="chat__composer">
				<AttachContextButton
					onMention={() => mentionRef.current?.trigger()}
					onLinkDocument={onLinkDocument}
					{...(onUploadMedia ? { onUploadMedia } : {})}
					labels={{
						button: t("composer.attach.button"),
						mention: t("composer.attach.mention"),
						linkDocument: t("composer.attach.linkDocument"),
						upload: t("composer.attach.upload"),
					}}
					disabled={disabled}
				/>
				<CompactEditor
					ref={editorRef}
					className="chat__composer-input"
					placeholder={placeholder}
					ariaLabel={placeholder}
					disabled={disabled}
					additionalNodes={[MentionNode]}
					onChange={(p) => {
						draftRef.current = p;
						setDraftEmpty(p.isEmpty);
					}}
					onSubmit={commit}
				>
					{/* Slack model: committing a person plants an inline mention chip in
					    the draft (no rail chip); the send path lifts it into the wire
					    attachment the notifier reads. */}
					<MentionComposerPlugin
						ref={mentionRef}
						host={host}
						insertNode
						ariaLabel={t("composer.attach.search")}
						emptyLabel={t("composer.attach.empty")}
					/>
				</CompactEditor>
				<button
					type="button"
					className="chat__icon-btn chat__composer-expand"
					aria-pressed={expanded}
					aria-label={expanded ? t("composer.collapse") : t("composer.expand")}
					data-bs-tooltip={expanded ? t("composer.collapse") : t("composer.expand")}
					onClick={onToggleExpanded}
					data-testid="composer-expand"
				>
					<Icon name={expanded ? IconName.CaretDown : IconName.CaretUp} size={16} />
				</button>
				<button
					type="button"
					className="chat__send"
					data-bs-primary=""
					disabled={disabled || (draftEmpty && attachments.attachments.length === 0)}
					onClick={() => commit(draftRef.current)}
					data-bs-tooltip={t("composer.send")}
					aria-label={t("composer.send")}
				>
					<Icon name={IconName.ArrowRight} size={18} />
				</button>
			</div>
		</div>
	);
}

// ───────────────────────────── members ─────────────────────────────

/** A short, human-checkable form of an `ed25519:<hex>` fingerprint for a member
 *  whose display name hasn't resolved yet. */
function shortFingerprint(fingerprint: string): string {
	const hex = fingerprint.startsWith("ed25519:")
		? fingerprint.slice("ed25519:".length)
		: fingerprint;
	return hex ? `${hex.slice(0, 6)}…` : "";
}

function MembersPanel({
	open,
	members,
	onEditIdentity,
}: {
	/** See `ChannelSidebar` — the members panel boots CLOSED, so without this
	 *  its rows and the edit-identity button are tabbable on every launch. */
	open: boolean;
	members: readonly PanelMember[];
	onEditIdentity: () => void;
}): ReactElement {
	return (
		<aside
			className="chat__members"
			aria-label={t("members.title")}
			aria-hidden={open ? undefined : true}
			inert={open ? undefined : true}
		>
			<div className="chat__members-header">
				<span className="chat__members-title">{t("members.title")}</span>
				<span className="chat__members-count">
					{plural(members.length, "members.one", "members.other")}
				</span>
			</div>
			<ul className="chat__members-list">
				{members.map((m) => {
					const name = m.displayName || shortFingerprint(m.fingerprint) || t("members.unknown");
					return (
						<li key={m.key} className="chat__member">
							<Avatar
								name={m.displayName || "?"}
								color={m.color}
								size={26}
								{...(m.avatarRef ? { avatarRef: m.avatarRef } : {})}
							/>
							<span className="chat__member-name">{name}</span>
							{m.legacy ? <span className="chat__member-tag">{t("members.guest")}</span> : null}
							{m.isSelf ? (
								<button type="button" className="chat__member-you" onClick={onEditIdentity}>
									{t("members.you")}
								</button>
							) : null}
						</li>
					);
				})}
			</ul>
		</aside>
	);
}

// ───────────────────────────── popovers ─────────────────────────────

function NewChannelPopover({
	onClose,
	onCreate,
}: {
	onClose: () => void;
	onCreate: (name: string, topic: string) => void;
}): ReactElement {
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const valid = name.trim().length > 0;
	return (
		<Popover
			title={t("newChannel.title")}
			onClose={onClose}
			footer={
				<>
					<button type="button" className="bs-btn" onClick={onClose}>
						{t("newChannel.cancel")}
					</button>
					<button
						type="button"
						className="bs-btn"
						data-bs-primary=""
						disabled={!valid}
						onClick={() => onCreate(name, topic)}
					>
						{t("newChannel.create")}
					</button>
				</>
			}
		>
			<label className="chat__field">
				<span className="chat__field-label">{t("newChannel.name.label")}</span>
				<input
					className="bs-input"
					value={name}
					placeholder={t("newChannel.name.placeholder")}
					// biome-ignore lint/a11y/noAutofocus: focusing the first field of a just-opened dialog is the expected affordance.
					autoFocus
					onChange={(e) => setName(e.target.value)}
					// keyboard-exempt: input-local commit — Enter submits the new-channel
					// field; field-scoped, not an app shortcut.
					onKeyDown={(e) => {
						if (e.key === "Enter" && valid) onCreate(name, topic);
					}}
				/>
			</label>
			<label className="chat__field">
				<span className="chat__field-label">{t("newChannel.topic.label")}</span>
				<input
					className="bs-input"
					value={topic}
					placeholder={t("newChannel.topic.placeholder")}
					onChange={(e) => setTopic(e.target.value)}
				/>
			</label>
		</Popover>
	);
}

function IdentityPopover({
	current,
	onClose,
	onSave,
}: {
	current: string;
	onClose: () => void;
	onSave: (name: string) => void;
}): ReactElement {
	const [name, setName] = useState(current);
	const valid = name.trim().length > 0;
	return (
		<Popover
			title={t("identity.title")}
			onClose={onClose}
			footer={
				<>
					<button type="button" className="bs-btn" onClick={onClose}>
						{t("identity.cancel")}
					</button>
					<button
						type="button"
						className="bs-btn"
						data-bs-primary=""
						disabled={!valid}
						onClick={() => onSave(name)}
					>
						{t("identity.save")}
					</button>
				</>
			}
		>
			<label className="chat__field">
				<span className="chat__field-label">{t("identity.label")}</span>
				<input
					className="bs-input"
					value={name}
					placeholder={t("identity.placeholder")}
					// biome-ignore lint/a11y/noAutofocus: focusing the only field of a just-opened dialog is the expected affordance.
					autoFocus
					onChange={(e) => setName(e.target.value)}
					// keyboard-exempt: input-local commit — Enter saves the identity-name
					// field; field-scoped, not an app shortcut.
					onKeyDown={(e) => {
						if (e.key === "Enter" && valid) onSave(name);
					}}
				/>
			</label>
		</Popover>
	);
}

import {
	CompactEditor,
	type CompactEditorHandle,
	type CompactEditorPayload,
	EntityIcon,
	type MentionComposerHandle,
	MentionComposerPlugin,
	renderEditorState,
} from "@brainstorm/editor";
import { useVaultEntities } from "@brainstorm/react-yjs";
import { AttachmentKind, type MessageAttachment, type RosterMember } from "@brainstorm/sdk-types";
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
} from "@brainstorm/sdk/composer-context";
import { EmptyState } from "@brainstorm/sdk/empty-state";
import { parseIcon } from "@brainstorm/sdk/entity-icon";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { MenuAlign, type SearchPickerItem, openSearchPicker } from "@brainstorm/sdk/menus";
import { closeObjectMenu, openAnchoredMenu } from "@brainstorm/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import { Popover } from "@brainstorm/sdk/popover";
import { ShareDialog, type ShareDialogLabels } from "@brainstorm/sdk/share-dialog";
import { friendlyTypeName } from "@brainstorm/sdk/system-entities";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactElement } from "react";
import { plural, t } from "./i18n";
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
import { getBrainstorm } from "./runtime";
import "./styles.css";

const DEFAULT_NAME = "You";

const EMPTY_COMPOSER_DRAFT: CompactEditorPayload = { state: "", text: "", isEmpty: true };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A pending optimistic echo of a just-sent message, keyed so it can be dropped
 *  once the persisted twin arrives over the reactive snapshot. */
type Pending = { channelId: string; message: ChatMessage };

const SHARE_DIALOG_LABELS: ShareDialogLabels = {
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

export function ChatApp(): ReactElement {
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

	// Composer context rail — @-mention people / link documents / attach media to a
	// message so it travels in the channel (the persona-agent reading it grounds on
	// the attachments). `@` is scoped to PEOPLE so the typeahead never mixes persons
	// and documents in one list; documents are pinned through their own affordance
	// (`linkDocument` below). Search runs over the live snapshot (the app holds
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
					const people = await roster.members(activeId);
					for (const m of people) {
						const name = m.displayName || m.fingerprint;
						if (q && !name.toLowerCase().includes(q)) continue;
						matches.push({
							id: m.pubkey,
							kind: AttachmentKind.Person,
							label: name,
							description: m.isSelf ? t("members.you") : m.fingerprint,
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
						const title = str(e.properties.title) || str(e.properties.name) || "";
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
							label: str(e.properties.title) || str(e.properties.name) || "",
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
	useEffect(() => {
		if (!roster) return;
		let live = true;
		roster
			.self()
			.then((self) => {
				if (live)
					setIdentity({
						personRef: self.pubkey,
						displayName: self.displayName || DEFAULT_NAME,
						...(self.avatarRef ? { avatarRef: self.avatarRef } : {}),
					});
			})
			.catch((err) => {
				console.warn("[chat] profile load failed; using local identity", err);
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
				attachments: [...atts],
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
						...(atts.length > 0 ? { attachments: atts } : {}),
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
	}, [canShare]);

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
					channels={channels}
					activeId={activeId}
					onSelect={setActiveId}
					onNew={() => setComposeNew(true)}
				/>

				<main className="chat__main">
					{activeChannel ? (
						<>
							<MessageView
								channel={activeChannel}
								groups={groups}
								avatarByAuthor={avatarByAuthor}
								emptyName={activeChannel.name}
							/>
							<Composer
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

				<MembersPanel members={members} onEditIdentity={() => setEditIdentity(true)} />
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
					labels={SHARE_DIALOG_LABELS}
					onClose={() => setShareOpen(false)}
				/>
			) : null}
		</div>
	);
}

// ───────────────────────────── sidebar ─────────────────────────────

function ChannelSidebar({
	channels,
	activeId,
	onSelect,
	onNew,
}: {
	channels: readonly ChatChannel[];
	activeId: string | null;
	onSelect: (id: string) => void;
	onNew: () => void;
}): ReactElement {
	return (
		<nav className="chat__sidebar" aria-label={t("sidebar.channels")}>
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
					{channels.map((c) => (
						<li key={c.id}>
							<button
								type="button"
								className={`chat__channel${c.id === activeId ? " chat__channel--active" : ""}`}
								aria-current={c.id === activeId ? "true" : undefined}
								onClick={() => onSelect(c.id)}
							>
								<span className="chat__channel-hash" aria-hidden="true">
									#
								</span>
								<span className="chat__channel-name">{c.name}</span>
							</button>
						</li>
					))}
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
}: {
	name: string;
	color: string;
	avatarRef?: string;
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
		return (
			<span className="chat__avatar chat__avatar--icon" aria-hidden="true">
				<EntityIcon icon={icon} size={28} />
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
}: {
	channel: ChatChannel;
	groups: ReturnType<typeof groupMessages>;
	avatarByAuthor: ReadonlyMap<string, string>;
	emptyName: string;
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
						{showDivider ? <DayDivider dayKey={g.dayKey} /> : null}
						<article className="chat__group">
							<Avatar name={g.authorName} color={g.color} {...(avatarRef ? { avatarRef } : {})} />
							<div className="chat__group-body">
								<header className="chat__group-head">
									<span className="chat__author" style={{ color: g.color }}>
										{g.authorName}
									</span>
									<time className="chat__time" dateTime={first?.createdAt}>
										{formatTime(first?.createdAt ?? "")}
									</time>
								</header>
								{g.messages.map((m) => (
									<div key={m.id} className="chat__line-wrap">
										{m.richBody ? (
											<div className="chat__line chat__line--rich bs-editor bs-editor--readonly">
												{renderEditorState(m.richBody)}
											</div>
										) : m.body ? (
											<p className="chat__line">{m.body}</p>
										) : null}
										{m.attachments.length > 0 ? (
											<div className="chat__attachments" data-testid="message-attachments">
												{m.attachments.map((a) => (
													<span key={a.ref} className="chat__attachment" data-kind={a.kind}>
														<Icon name={attachmentIcon(a.kind)} size={12} />
														{attachmentLabel(a)}
													</span>
												))}
											</div>
										) : null}
									</div>
								))}
							</div>
						</article>
					</div>
				);
			})}
		</div>
	);
}

function DayDivider({ dayKey }: { dayKey: string }): ReactElement {
	return (
		<div className="chat__day">
			<span className="chat__day-label">{formatDay(dayKey)}</span>
		</div>
	);
}

// ───────────────────────────── composer ─────────────────────────────

function Composer({
	channelName,
	onSend,
	disabled,
	host,
	attachments,
	onLinkDocument,
	onUploadMedia,
}: {
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
			className={`chat__composer-wrap${objectDrop.isOver ? " chat__composer-wrap--drop" : ""}`}
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
					onChange={(p) => {
						draftRef.current = p;
						setDraftEmpty(p.isEmpty);
					}}
					onSubmit={commit}
				>
					<MentionComposerPlugin
						ref={mentionRef}
						host={host}
						onSelect={(candidate) => attachments.add(candidateToAttachment(candidate))}
						ariaLabel={t("composer.attach.search")}
						emptyLabel={t("composer.attach.empty")}
					/>
				</CompactEditor>
				<button
					type="button"
					className="chat__send"
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
	members,
	onEditIdentity,
}: {
	members: readonly PanelMember[];
	onEditIdentity: () => void;
}): ReactElement {
	return (
		<aside className="chat__members" aria-label={t("members.title")}>
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

// ───────────────────────────── formatting ─────────────────────────────

function navigatorLanguage(): string {
	return typeof navigator !== "undefined" ? navigator.language || "en" : "en";
}

/** `HH:MM` in the user's locale; "" for an unparseable stamp. */
function formatTime(iso: string): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return "";
	return new Date(ms).toLocaleTimeString(navigatorLanguage(), {
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** A friendly day-divider label: Today / Yesterday / a localized date. */
function formatDay(dayKey: string): string {
	const ms = Date.parse(dayKey);
	if (!Number.isFinite(ms)) return dayKey;
	const that = new Date(ms);
	const now = new Date();
	const startOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	const diffDays = Math.round((startOf(now) - startOf(that)) / 86_400_000);
	if (diffDays === 0) return t("day.today");
	if (diffDays === 1) return t("day.yesterday");
	return that.toLocaleDateString(navigatorLanguage(), {
		weekday: "long",
		month: "short",
		day: "numeric",
	});
}

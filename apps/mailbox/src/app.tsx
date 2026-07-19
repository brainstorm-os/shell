/**
 * Mailbox — a viewer over the `Email/v1` / `MailFolder/v1` / `MailAccount/v1`
 * entities the shell-side `MailTransport` worker projects (doc 53). Live mail
 * comes ONLY through the one sanctioned reactivity stack (`useVaultEntities`,
 * never a hand-rolled `onChange` loop). Received mail is immutable; the only
 * writes are `flags` (server state, synced back by the worker). Outside the
 * shell it runs on an in-memory demo set through the same projection code.
 */

import { useVaultEntities } from "@brainstorm/react-yjs";
import { MailFlag, SendIntentVerb } from "@brainstorm/sdk-types";
import { EmptyState } from "@brainstorm/sdk/empty-state";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { MenuAlign } from "@brainstorm/sdk/menus";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, MouseEvent as ReactMouseEvent } from "react";
import { t } from "./i18n";
import { useMailboxT } from "./i18n-hooks";
import {
	type ComposeSeed,
	emptySeed,
	forwardSeed,
	replySeed,
	seedFromIntentPayload,
} from "./logic/compose";
import { demoEntities } from "./logic/demo";
import {
	accountsFromEntities,
	foldersFromEntities,
	groupThreads,
	matchesQuery,
	messagesForSelection,
	messagesFromEntities,
	senderLabel,
	unifiedUnreadCount,
} from "./logic/mail-view";
import { SyncErrorClass, classifySyncError } from "./logic/sync-error";
import { getBrainstorm } from "./runtime";
import {
	EMAIL_TYPE_URL,
	type FolderSelection,
	type MessageView,
	type VaultEntityLike,
} from "./types/mail-view";
import { Composer } from "./ui/composer";
import {
	ConnectAccountDialog,
	type ConnectAccountInput,
	type ConnectImapInput,
	type ReconnectSeed,
} from "./ui/connect-account";
import { FolderRail } from "./ui/folder-rail";
import { MessageList } from "./ui/message-list";
import { ReadingPane } from "./ui/reading-pane";

function withFlag(flags: MailFlag[], flag: MailFlag, on: boolean): MailFlag[] {
	const has = flags.includes(flag);
	if (on === has) return flags;
	return on ? [...flags, flag] : flags.filter((f) => f !== flag);
}

const SyncNoteKind = {
	Info: "info",
	Error: "error",
} as const;
type SyncNoteKind = (typeof SyncNoteKind)[keyof typeof SyncNoteKind];

type SyncNote = {
	kind: SyncNoteKind;
	text: string;
	/** Auth failures offer the reconnect escape hatch inline — the banner's
	 *  "reconnect the account" advice was previously a dead end. */
	reconnect?: boolean;
	/** The account whose sync failed — seeds reconnect-in-place (Mailbox-13). */
	reconnectAccountRef?: string;
};

const SYNC_NOTE_TTL_MS = 6000;

export function MailboxApp(): ReactElement {
	useMailboxT();
	const rt = getBrainstorm();
	const vaultEntitiesSvc = rt?.services?.vaultEntities ?? null;
	const entitiesSvc = rt?.services?.entities ?? null;
	const mailSvc = rt?.services?.mail ?? null;
	const intentsSvc = rt?.services?.intents ?? null;
	const usingVault = Boolean(vaultEntitiesSvc && entitiesSvc);

	const { entities: vaultEntities } = useVaultEntities(vaultEntitiesSvc);
	const [demo, setDemo] = useState<VaultEntityLike[]>(() => demoEntities());
	const allEntities: VaultEntityLike[] = usingVault ? vaultEntities : demo;

	const accounts = useMemo(() => accountsFromEntities(allEntities), [allEntities]);
	const folders = useMemo(() => foldersFromEntities(allEntities), [allEntities]);
	const messages = useMemo(() => messagesFromEntities(allEntities), [allEntities]);

	const [selection, setSelection] = useState<FolderSelection>({ kind: "unified-inbox" });
	const [query, setQuery] = useState("");
	const [activeId, setActiveId] = useState<string | null>(null);
	const [railOpen, setRailOpen] = useState(true);
	const [threaded, setThreaded] = useState(true);
	const [expandedThreads, setExpandedThreads] = useState<ReadonlySet<string>>(() => new Set());
	const [connectOpen, setConnectOpen] = useState(false);
	const [reconnectSeed, setReconnectSeed] = useState<ReconnectSeed | null>(null);
	const [composeSeed, setComposeSeed] = useState<ComposeSeed | null>(null);
	const [syncBusy, setSyncBusy] = useState(false);
	const [syncNote, setSyncNote] = useState<SyncNote | null>(null);
	// Re-entry latch as a ref, not state: two clicks before a re-render would
	// both see stale `syncBusy === false` and double-launch the sync.
	const syncRunRef = useRef(false);

	// Success/status notes dismiss themselves; errors stay until acted on.
	useEffect(() => {
		if (!syncNote || syncNote.kind !== SyncNoteKind.Info || syncBusy) return;
		const timer = setTimeout(() => setSyncNote(null), SYNC_NOTE_TTL_MS);
		return () => clearTimeout(timer);
	}, [syncNote, syncBusy]);

	const now = useRef(Date.now()).current;

	const visible = useMemo(() => {
		const inSelection = messagesForSelection(messages, folders, selection);
		return inSelection.filter((m) => matchesQuery(m, query));
	}, [messages, folders, selection, query]);

	const threads = useMemo(() => groupThreads(visible), [visible]);

	const toggleThreaded = useCallback(() => setThreaded((on) => !on), []);

	const toggleThreadExpand = useCallback((threadKey: string) => {
		setExpandedThreads((prev) => {
			const next = new Set(prev);
			if (next.has(threadKey)) {
				next.delete(threadKey);
			} else {
				next.add(threadKey);
			}
			return next;
		});
	}, []);

	const unifiedUnread = useMemo(() => unifiedUnreadCount(messages, folders), [messages, folders]);

	const activeMessage = useMemo(
		() => (activeId ? (messages.find((m) => m.id === activeId) ?? null) : null),
		[activeId, messages],
	);

	// Latest messages for the (once-subscribed) inbound-intent handler — the
	// push channel has no unsubscribe contract, so re-subscribing per render
	// would stack handlers.
	const messagesRef = useRef(messages);
	messagesRef.current = messages;

	const quoteHeaderFor = useCallback((message: MessageView | null): string => {
		const sender = message ? senderLabel(message) : "";
		return t("compose.quoteHeader", { sender: sender || t("list.noSender") });
	}, []);

	const openComposeForIntent = useCallback(
		(verb: string, payload: Record<string, unknown>) => {
			const find = (entityId: string): MessageView | null =>
				messagesRef.current.find((m) => m.id === entityId) ?? null;
			const original = typeof payload.entityId === "string" ? find(payload.entityId) : null;
			setComposeSeed(seedFromIntentPayload(verb, payload, find, quoteHeaderFor(original)));
		},
		[quoteHeaderFor],
	);

	// Mailbox-4 — inbound compose/reply/forward. A fresh window carries the
	// intent on the launch context; a running window receives the
	// `app:intent` push re-emitted through the lifecycle channel.
	const intentWiredRef = useRef(false);
	useEffect(() => {
		if (intentWiredRef.current || !rt) return;
		intentWiredRef.current = true;
		const isComposerVerb = (verb: string): boolean =>
			verb === SendIntentVerb.Compose ||
			verb === SendIntentVerb.Reply ||
			verb === SendIntentVerb.Forward;
		if (rt.launch?.reason === "intent" && isComposerVerb(rt.launch.intent.verb)) {
			openComposeForIntent(rt.launch.intent.verb, rt.launch.intent.payload);
		}
		rt.on?.("intent", (event) => {
			if (event.type !== "intent") return;
			const { verb, payload } = event.intent;
			if (isComposerVerb(verb)) openComposeForIntent(verb, payload);
		});
	}, [rt, openComposeForIntent]);

	const onCompose = useCallback(() => {
		setComposeSeed(emptySeed(accounts[0]?.id));
	}, [accounts]);

	const onReply = useCallback(() => {
		if (!activeMessage) return;
		setComposeSeed(replySeed(activeMessage, quoteHeaderFor(activeMessage)));
	}, [activeMessage, quoteHeaderFor]);

	const onForward = useCallback(() => {
		if (!activeMessage) return;
		setComposeSeed(forwardSeed(activeMessage, quoteHeaderFor(activeMessage)));
	}, [activeMessage, quoteHeaderFor]);

	const onSend = useCallback(
		async (payload: Record<string, unknown>) => {
			if (!intentsSvc) throw new Error(t("compose.error", { message: "intents unavailable" }));
			const result = await intentsSvc.dispatch({ verb: SendIntentVerb.Send, payload });
			if (!result || !result.handled) {
				const message =
					(result as { message?: string } | null)?.message ?? t("compose.error", { message: "" });
				throw new Error(message);
			}
			setSyncNote({ kind: SyncNoteKind.Info, text: t("compose.sent") });
		},
		[intentsSvc],
	);

	const canCompose = usingVault && Boolean(intentsSvc) && accounts.length > 0;

	const patchFlags = useCallback(
		(id: string, next: MailFlag[]) => {
			if (usingVault && entitiesSvc) {
				void entitiesSvc.update(id, { flags: next });
			} else {
				setDemo((prev) =>
					prev.map((e) =>
						e.id === id && e.type === EMAIL_TYPE_URL
							? { ...e, properties: { ...e.properties, flags: next } }
							: e,
					),
				);
			}
		},
		[usingVault, entitiesSvc],
	);

	const selectMessage = useCallback(
		(id: string) => {
			setActiveId(id);
			// Opening a message marks it read (standard mail UX) — a flag mutation,
			// the one kind of write allowed on immutable received mail.
			const msg = messages.find((m) => m.id === id);
			if (msg?.unread) patchFlags(id, withFlag(msg.flags, MailFlag.Unread, false));
		},
		[messages, patchFlags],
	);

	const onSelectFolder = useCallback((next: FolderSelection) => {
		setSelection(next);
		setActiveId(null);
	}, []);

	const toggleRead = useCallback(() => {
		if (!activeMessage) return;
		patchFlags(
			activeMessage.id,
			withFlag(activeMessage.flags, MailFlag.Unread, !activeMessage.unread),
		);
	}, [activeMessage, patchFlags]);

	const toggleFlag = useCallback(() => {
		if (!activeMessage) return;
		patchFlags(
			activeMessage.id,
			withFlag(activeMessage.flags, MailFlag.Flagged, !activeMessage.flagged),
		);
	}, [activeMessage, patchFlags]);

	const syncAccounts = useCallback(
		async (accountIds: readonly string[]) => {
			if (!mailSvc || accountIds.length === 0 || syncRunRef.current) return;
			syncRunRef.current = true;
			setSyncBusy(true);
			setSyncNote({ kind: SyncNoteKind.Info, text: t("sync.running") });
			let failingAccount: string | undefined;
			try {
				let created = 0;
				let updated = 0;
				for (const id of accountIds) {
					failingAccount = id;
					const result = await mailSvc.syncNow({ accountRef: id });
					created += result.created;
					updated += result.updated;
				}
				setSyncNote({ kind: SyncNoteKind.Info, text: t("sync.done", { created, updated }) });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// Repairable failure classes (credentials, connectivity) speak
				// human and carry the reconnect affordance — Edit connection fixes
				// a dead host exactly like a bad password (F-445, session 908).
				const errorClass = classifySyncError(message);
				const repairable = errorClass !== SyncErrorClass.Other;
				setSyncNote({
					kind: SyncNoteKind.Error,
					text:
						errorClass === SyncErrorClass.Auth
							? t("sync.errorAuth")
							: errorClass === SyncErrorClass.Connect
								? t("sync.errorConnect")
								: t("sync.error", { message }),
					...(repairable ? { reconnect: true } : {}),
					...(repairable && failingAccount !== undefined ? { reconnectAccountRef: failingAccount } : {}),
				});
			} finally {
				syncRunRef.current = false;
				setSyncBusy(false);
			}
		},
		[mailSvc],
	);

	const onSyncNow = useCallback(() => {
		void syncAccounts(accounts.map((a) => a.id));
	}, [syncAccounts, accounts]);

	// Mailbox-12: one bounded older-page per account per press; the folder
	// cursors persist server-side state, so repeated presses walk deeper.
	const [loadingOlder, setLoadingOlder] = useState(false);
	const onLoadOlder = useCallback(() => {
		if (!mailSvc || accounts.length === 0 || loadingOlder) return;
		setLoadingOlder(true);
		void (async () => {
			try {
				let created = 0;
				let allDone = true;
				for (const account of accounts) {
					const result = await mailSvc.loadOlder({ accountRef: account.id });
					created += result.created;
					if (!result.done) allDone = false;
				}
				setSyncNote({
					kind: SyncNoteKind.Info,
					text: t(allDone ? "sync.olderDone" : "sync.olderMore", { created }),
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setSyncNote(
					/authentication failed/i.test(message)
						? { kind: SyncNoteKind.Error, text: t("sync.errorAuth"), reconnect: true }
						: { kind: SyncNoteKind.Error, text: t("sync.error", { message }) },
				);
			} finally {
				setLoadingOlder(false);
			}
		})();
	}, [mailSvc, accounts, loadingOlder]);

	const olderExhausted = useMemo(
		() => folders.length > 0 && folders.every((f) => f.backfillDone),
		[folders],
	);

	const onSyncAccount = useCallback(
		(accountId: string) => {
			void syncAccounts([accountId]);
		},
		[syncAccounts],
	);

	// `mail.disconnect` retires the account (credential deleted, row disabled);
	// synced mail keeps its entities, so no confirm step — mirrors Calendar's
	// CalDAV disconnect.
	// Mailbox-13: open the dialog pre-filled with the account's stored
	// coordinates so only the password needs re-entering.
	const openReconnect = useCallback(
		(accountId: string) => {
			const account = accounts.find((a) => a.id === accountId);
			if (!account?.imap) {
				setConnectOpen(true);
				return;
			}
			setReconnectSeed({
				accountRef: account.id,
				address: account.address,
				incoming: account.imap.incoming,
				outgoing: account.imap.outgoing,
				...(account.imap.syncWindow !== undefined ? { syncWindow: account.imap.syncWindow } : {}),
			});
			setConnectOpen(true);
		},
		[accounts],
	);

	const onRemoveAccount = useCallback(
		(accountId: string) => {
			if (!mailSvc) return;
			void mailSvc
				.disconnect({ accountRef: accountId })
				.then(() => setSyncNote({ kind: SyncNoteKind.Info, text: t("account.removed") }))
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					setSyncNote({ kind: SyncNoteKind.Error, text: t("sync.error", { message }) });
				});
		},
		[mailSvc],
	);

	const onConnect = useCallback(
		async (input: ConnectAccountInput) => {
			if (!mailSvc) throw new Error(t("sync.error", { message: "mail service unavailable" }));
			const result = await mailSvc.connectGmail(input);
			// First sync right after consent so the new account isn't an empty rail.
			void syncAccounts([result.accountId]);
		},
		[mailSvc, syncAccounts],
	);

	const onConnectImap = useCallback(
		async (input: ConnectImapInput) => {
			if (!mailSvc) throw new Error(t("sync.error", { message: "mail service unavailable" }));
			const result = await mailSvc.connectImap(input);
			void syncAccounts([result.accountId]);
		},
		[mailSvc, syncAccounts],
	);

	// The trailing-edge ⋯ catch-all every app header carries (CLAUDE.md
	// §header object-menu) — folder-scoped actions live here, not as loose
	// header buttons.
	const onMoreClick = useCallback(
		(event: ReactMouseEvent<HTMLButtonElement>) => {
			const button = event.currentTarget;
			const unread = visible.filter((m) => m.unread);
			const items: AnchoredMenuItem[] = [
				{
					label: t("menu.markAllRead"),
					icon: IconName.Read,
					disabled: unread.length === 0,
					onSelect: () => {
						for (const m of unread) patchFlags(m.id, withFlag(m.flags, MailFlag.Unread, false));
					},
				},
				...(usingVault && mailSvc
					? [
							{
								label: t("menu.syncNow"),
								icon: IconName.Reload,
								disabled: syncBusy || accounts.length === 0,
								onSelect: onSyncNow,
							},
							{
								label: t("menu.connect"),
								icon: IconName.Plus,
								onSelect: () => setConnectOpen(true),
							},
						]
					: []),
			];
			const r = button.getBoundingClientRect();
			openAnchoredMenu({ x: r.left, y: r.bottom + 4 }, items, {
				menuLabel: t("header.menu"),
				anchor: button,
				align: MenuAlign.End,
			});
		},
		[visible, patchFlags, usingVault, mailSvc, syncBusy, accounts.length, onSyncNow],
	);

	const showConnectCta = usingVault && Boolean(mailSvc) && accounts.length === 0;

	return (
		<div className="mb-app">
			<header className="app-header" data-testid="app-header">
				<div className="app-header__left">
					<h1 className="app-header__title">{t("app.title")}</h1>
				</div>
				<div className="app-header__right">
					{canCompose ? (
						<button
							type="button"
							className="mb-iconbtn"
							onClick={onCompose}
							aria-label={t("compose.open")}
							data-bs-tooltip={t("compose.open")}
						>
							<Icon name={IconName.Pencil} />
						</button>
					) : null}
					{usingVault && mailSvc && accounts.length > 0 ? (
						<button
							type="button"
							className={`mb-iconbtn${syncBusy ? " is-on" : ""}`}
							onClick={onSyncNow}
							disabled={syncBusy}
							aria-busy={syncBusy}
							aria-label={t("header.syncNow")}
							data-bs-tooltip={t("header.syncNow")}
							title={syncBusy ? t("header.syncNow") : undefined}
						>
							<Icon name={IconName.Reload} />
						</button>
					) : null}
					{!showConnectCta ? (
						<PanelToggleButton
							side={PanelSide.Left}
							open={railOpen}
							onClick={() => setRailOpen((open) => !open)}
							controls="mb-rail"
							labels={{ show: t("header.sidebar.show"), hide: t("header.sidebar.hide") }}
						/>
					) : null}
					<button
						type="button"
						className="bs-object-menu__more"
						aria-haspopup="menu"
						aria-label={t("header.menu")}
						data-bs-tooltip={t("header.menu")}
						onClick={onMoreClick}
					>
						<span className="bs-object-menu__more-dot" />
						<span className="bs-object-menu__more-dot" />
						<span className="bs-object-menu__more-dot" />
					</button>
				</div>
			</header>
			{!usingVault ? <div className="mb-demo-banner">{t("demo.banner")}</div> : null}
			{syncNote ? (
				<div
					className={`mb-syncbar${syncNote.kind === SyncNoteKind.Error ? " mb-syncbar--error" : ""}`}
					role={syncNote.kind === SyncNoteKind.Error ? "alert" : "status"}
					aria-busy={syncBusy}
				>
					<span className="mb-syncbar__text">{syncNote.text}</span>
					{syncNote.reconnect && !syncBusy ? (
						<button
							type="button"
							className="bs-btn bs-btn--secondary mb-syncbar__action"
							onClick={() => {
								if (syncNote.reconnectAccountRef !== undefined) {
									openReconnect(syncNote.reconnectAccountRef);
								} else {
									setConnectOpen(true);
								}
							}}
						>
							{t("sync.reconnect")}
						</button>
					) : null}
					{!syncBusy ? (
						<button
							type="button"
							className="mb-iconbtn mb-syncbar__dismiss"
							onClick={() => setSyncNote(null)}
							aria-label={t("sync.dismiss")}
						>
							<Icon name={IconName.Close} />
						</button>
					) : null}
				</div>
			) : null}
			{showConnectCta ? (
				<div className="mb-cta">
					<EmptyState
						icon={IconName.KindEmail}
						title={t("cta.title")}
						hint={t("cta.blurb")}
						action={
							<button
								type="button"
								className="bs-btn bs-btn--lg"
								data-bs-primary
								onClick={() => setConnectOpen(true)}
							>
								{t("cta.connect")}
							</button>
						}
					/>
				</div>
			) : (
				<div className={`mb-app__panes${railOpen ? "" : " mb-app__panes--rail-closed"}`}>
					<FolderRail
						accounts={accounts}
						folders={folders}
						selection={selection}
						unifiedUnread={unifiedUnread}
						onSelect={onSelectFolder}
						{...(usingVault && mailSvc
							? { onSyncAccount, onRemoveAccount, onEditAccount: openReconnect }
							: {})}
					/>
					<MessageList
						messages={visible}
						threads={threads}
						threaded={threaded}
						expandedThreads={expandedThreads}
						activeId={activeId}
						now={now}
						query={query}
						onQueryChange={setQuery}
						onSelect={selectMessage}
						onToggleThreaded={toggleThreaded}
						onToggleThreadExpand={toggleThreadExpand}
						syncFailed={syncNote?.kind === SyncNoteKind.Error}
						{...(usingVault && mailSvc && accounts.length > 0
							? { onLoadOlder, loadingOlder, olderExhausted }
							: {})}
					/>
					<ReadingPane
						message={activeMessage}
						now={now}
						showBack={false}
						onBack={() => setActiveId(null)}
						onToggleRead={toggleRead}
						onToggleFlag={toggleFlag}
						{...(canCompose ? { onReply, onForward } : {})}
					/>
				</div>
			)}
			{connectOpen ? (
				<ConnectAccountDialog
					onClose={() => {
						setConnectOpen(false);
						setReconnectSeed(null);
					}}
					onConnect={onConnect}
					onConnectImap={onConnectImap}
					{...(reconnectSeed !== null ? { reconnect: reconnectSeed } : {})}
				/>
			) : null}
			{composeSeed ? (
				<Composer
					seed={composeSeed}
					accounts={accounts}
					onClose={() => setComposeSeed(null)}
					onSend={onSend}
				/>
			) : null}
		</div>
	);
}

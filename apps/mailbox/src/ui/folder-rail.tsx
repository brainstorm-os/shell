/** Left rail: the unified-inbox + flagged smart views, then each account's
 *  real folders grouped under its address. Selection drives the message
 *  list (`FolderSelection`). */

import { Icon, IconName } from "@brainstorm/sdk/icon";
import { MenuAlign } from "@brainstorm/sdk/menus";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm/sdk/object-menu";
import type { ReactElement, MouseEvent as ReactMouseEvent } from "react";
import { t } from "../i18n";
import {
	type AccountView,
	FolderRole,
	type FolderSelection,
	type FolderView,
} from "../types/mail-view";

const ROLE_ICON: Record<FolderRole, IconName> = {
	[FolderRole.Inbox]: IconName.Inbox,
	[FolderRole.Sent]: IconName.KindEmail,
	[FolderRole.Drafts]: IconName.Pencil,
	[FolderRole.Archive]: IconName.Archive,
	[FolderRole.Trash]: IconName.Trash,
	[FolderRole.Spam]: IconName.Warning,
	[FolderRole.Custom]: IconName.Folder,
};

const ROLE_LABEL: Partial<Record<FolderRole, () => string>> = {
	[FolderRole.Sent]: () => t("folders.sent"),
	[FolderRole.Drafts]: () => t("folders.drafts"),
	[FolderRole.Archive]: () => t("folders.archive"),
	[FolderRole.Trash]: () => t("folders.trash"),
	[FolderRole.Spam]: () => t("folders.spam"),
};

function folderLabel(folder: FolderView): string {
	const named = ROLE_LABEL[folder.role];
	if (named) return named();
	// Servers report hierarchical paths ("INBOX/Social") — the INBOX/ prefix
	// is transport detail, not a name the rail should show.
	return folder.path.replace(/^INBOX\//i, "");
}

function selectionMatches(a: FolderSelection, b: FolderSelection): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "folder" && b.kind === "folder") return a.folderId === b.folderId;
	return true;
}

type RailItemProps = {
	icon: IconName;
	label: string;
	unread?: number;
	active: boolean;
	onSelect: () => void;
};

function RailItem({ icon, label, unread, active, onSelect }: RailItemProps): ReactElement {
	return (
		<button
			type="button"
			className={`mb-rail__item${active ? " is-active" : ""}`}
			aria-current={active ? "true" : undefined}
			onClick={onSelect}
		>
			<Icon name={icon} className="mb-rail__icon" />
			<span className="mb-rail__label">{label}</span>
			{unread && unread > 0 ? (
				<span className="mb-rail__badge" aria-label={t("folders.unreadAria", { count: unread })}>
					{unread}
				</span>
			) : null}
		</button>
	);
}

export type FolderRailProps = {
	accounts: AccountView[];
	folders: FolderView[];
	selection: FolderSelection;
	unifiedUnread: number;
	onSelect: (selection: FolderSelection) => void;
	/** Vault mode only — absent in the demo set, which hides the account ⋯. */
	onSyncAccount?: (accountId: string) => void;
	onRemoveAccount?: (accountId: string) => void;
	/** Reconnect-in-place (Mailbox-13) — IMAP accounts only. */
	onEditAccount?: (accountId: string) => void;
};

export function FolderRail({
	accounts,
	folders,
	selection,
	unifiedUnread,
	onSelect,
	onSyncAccount,
	onRemoveAccount,
	onEditAccount,
}: FolderRailProps): ReactElement {
	// Real folders that are not inbox-role (inbox is the unified smart view).
	const nonInbox = folders.filter((f) => f.role !== FolderRole.Inbox);
	const byAccount = new Map<string, FolderView[]>();
	for (const f of nonInbox) {
		const list = byAccount.get(f.accountRef) ?? [];
		list.push(f);
		byAccount.set(f.accountRef, list);
	}

	return (
		<nav className="mb-rail" id="mb-rail" aria-label={t("folders.aria")}>
			<div className="mb-rail__group">
				<RailItem
					icon={IconName.Inbox}
					label={t("folders.unified")}
					unread={unifiedUnread}
					active={selectionMatches(selection, { kind: "unified-inbox" })}
					onSelect={() => onSelect({ kind: "unified-inbox" })}
				/>
				<RailItem
					icon={IconName.Star}
					label={t("folders.flagged")}
					active={selectionMatches(selection, { kind: "flagged" })}
					onSelect={() => onSelect({ kind: "flagged" })}
				/>
			</div>
			{accounts.map((account) => {
				const accountFolders = byAccount.get(account.id) ?? [];
				const hasMenu = Boolean(onSyncAccount || onRemoveAccount);
				const openAccountMenu = (event: ReactMouseEvent<HTMLButtonElement>): void => {
					const button = event.currentTarget;
					const items: AnchoredMenuItem[] = [
						...(onSyncAccount
							? [
									{
										label: t("account.syncNow"),
										icon: IconName.Reload,
										onSelect: () => onSyncAccount(account.id),
									},
								]
							: []),
						...(onEditAccount && account.imap
							? [
									{
										label: t("account.edit"),
										icon: IconName.Pencil,
										onSelect: () => onEditAccount(account.id),
									},
								]
							: []),
						...(onRemoveAccount
							? [
									{
										label: t("account.remove"),
										icon: IconName.Trash,
										onSelect: () => onRemoveAccount(account.id),
									},
								]
							: []),
					];
					const r = button.getBoundingClientRect();
					openAnchoredMenu({ x: r.left, y: r.bottom + 4 }, items, {
						menuLabel: t("account.menu", { name: account.displayName }),
						anchor: button,
						align: MenuAlign.End,
					});
				};
				return (
					<div className="mb-rail__group" key={account.id}>
						<div className="mb-rail__heading">
							<span className="mb-rail__heading-label">{account.displayName}</span>
							{hasMenu ? (
								<button
									type="button"
									className="bs-object-menu__more mb-rail__heading-menu"
									aria-haspopup="menu"
									aria-label={t("account.menu", { name: account.displayName })}
									data-bs-tooltip={t("account.menu", { name: account.displayName })}
									onClick={openAccountMenu}
								>
									<span className="bs-object-menu__more-dot" />
									<span className="bs-object-menu__more-dot" />
									<span className="bs-object-menu__more-dot" />
								</button>
							) : null}
						</div>
						{accountFolders.length === 0 ? (
							<div className="mb-rail__hint">{t("folders.notSynced")}</div>
						) : null}
						{accountFolders.map((folder) => (
							<RailItem
								key={folder.id}
								icon={ROLE_ICON[folder.role]}
								label={folderLabel(folder)}
								unread={folder.unreadCount}
								active={selectionMatches(selection, { kind: "folder", folderId: folder.id })}
								onSelect={() => onSelect({ kind: "folder", folderId: folder.id })}
							/>
						))}
					</div>
				);
			})}
		</nav>
	);
}

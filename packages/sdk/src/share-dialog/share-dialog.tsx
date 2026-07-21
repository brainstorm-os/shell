/**
 * `<ShareDialog>` (Collab-C5) — the shared, app-agnostic surface for
 * multi-user sharing. Renders an entity's member list (roster), lets an Owner
 * add a collaborator by their pasted invite **code** (the v1 invite-exchange
 * UX) with a role, revoke a member, and mint THIS user's own invite code to
 * hand to an Owner.
 *
 * It is a leaf SDK component: it takes already-translated `labels` (the SDK
 * bundles no formatter) and the two services it drives (`sharing` + `roster`),
 * so any first-party app that declares `sharing.share` can drop it into its
 * object menu. The privileged grant/revoke stays behind `sharing.share`
 * (scarce, server-re-checked); `canManage` only gates the UI affordances.
 */

import type {
	RosterMember,
	RosterService,
	SharedContact,
	SharingService,
} from "@brainstorm-os/sdk-types";
import { RosterRole } from "@brainstorm-os/sdk-types";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { Icon, IconName } from "../icon";
import { Popover } from "../popover";
import { SelectMenu } from "../select-menu";

export type ShareDialogLabels = {
	title: string;
	membersHeading: string;
	you: string;
	roleOwner: string;
	roleEditor: string;
	roleViewer: string;
	revoke: string;
	addHeading: string;
	codePlaceholder: string;
	canEdit: string;
	canView: string;
	add: string;
	/** Heading for the click-to-add known-teammates section (share-by-name). */
	quickAddHeading: string;
	inviteHeading: string;
	getCode: string;
	copy: string;
	copied: string;
	inviteHint: string;
	shareFailed: string;
	revokeFailed: string;
	loadFailed: string;
	done: string;
};

/** The services this dialog drives — narrowed so a consumer can pass the live
 *  `services.sharing` / `services.roster` (or a fake in tests). */
export type ShareDialogProps = {
	entityId: string;
	entityType: string;
	sharing: Pick<
		SharingService,
		"createInvite" | "share" | "shareCollection" | "saveContact" | "listContacts" | "revoke"
	>;
	roster: Pick<RosterService, "members">;
	/** True when the local user is the entity Owner — gates add / revoke. */
	canManage: boolean;
	/** When the entity is a COLLECTION container (a chat Channel, a Project),
	 *  share via `shareCollection` so the grant cascades to its children (its
	 *  messages / tasks). Default false → a single-entity `share` (a Note). */
	collection?: boolean;
	labels: ShareDialogLabels;
	onClose: () => void;
	testId?: string;
};

const EDITOR = RosterRole.Editor;
const VIEWER = RosterRole.Viewer;
const OWNER = RosterRole.Owner;

function memberName(m: RosterMember, youLabel: string): string {
	if (m.isSelf) return m.displayName ? `${m.displayName} (${youLabel})` : youLabel;
	return m.displayName || m.fingerprint;
}

export function ShareDialog(props: ShareDialogProps): ReactElement {
	const { entityId, entityType, sharing, roster, canManage, labels, onClose } = props;
	const [members, setMembers] = useState<RosterMember[]>([]);
	const [contacts, setContacts] = useState<SharedContact[]>([]);
	const [code, setCode] = useState("");
	const [role, setRole] = useState<RosterRole>(EDITOR);
	const [myCode, setMyCode] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			setMembers(await roster.members(entityId));
		} catch {
			setError(labels.loadFailed);
		}
		// Contacts are a convenience (share-by-name); a failure here must not block
		// the member list or the paste-a-code path.
		try {
			setContacts(await sharing.listContacts());
		} catch {
			setContacts([]);
		}
	}, [roster, sharing, entityId, labels.loadFailed]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const roleLabel = useCallback(
		(r: RosterRole): string =>
			r === OWNER ? labels.roleOwner : r === VIEWER ? labels.roleViewer : labels.roleEditor,
		[labels.roleOwner, labels.roleViewer, labels.roleEditor],
	);

	const onAdd = useCallback(async () => {
		const invite = code.trim();
		if (!invite || busy) return;
		setBusy(true);
		setError(null);
		try {
			const input = { entityId, type: entityType, invite, role };
			await (props.collection ? sharing.shareCollection(input) : sharing.share(input));
			// Remember this teammate so next time they're a one-click chip
			// (best-effort — a failed save must not fail the share).
			try {
				await sharing.saveContact({ invite, displayName: "" });
			} catch {
				/* non-fatal */
			}
			setCode("");
			await reload();
		} catch {
			setError(labels.shareFailed);
		} finally {
			setBusy(false);
		}
	}, [
		code,
		busy,
		sharing,
		entityId,
		entityType,
		role,
		reload,
		labels.shareFailed,
		props.collection,
	]);

	const onAddContact = useCallback(
		async (pubkey: string) => {
			if (busy) return;
			setBusy(true);
			setError(null);
			try {
				const input = { entityId, type: entityType, contact: pubkey, role };
				await (props.collection ? sharing.shareCollection(input) : sharing.share(input));
				await reload();
			} catch {
				setError(labels.shareFailed);
			} finally {
				setBusy(false);
			}
		},
		[busy, sharing, entityId, entityType, role, reload, labels.shareFailed, props.collection],
	);

	const onRevoke = useCallback(
		async (pubkey: string) => {
			if (busy) return;
			setBusy(true);
			setError(null);
			try {
				await sharing.revoke({ entityId, type: entityType, member: pubkey });
				await reload();
			} catch {
				setError(labels.revokeFailed);
			} finally {
				setBusy(false);
			}
		},
		[busy, sharing, entityId, entityType, reload, labels.revokeFailed],
	);

	const onGetCode = useCallback(async () => {
		setError(null);
		try {
			setMyCode(await sharing.createInvite(""));
			setCopied(false);
		} catch {
			setError(labels.shareFailed);
		}
	}, [sharing, labels.shareFailed]);

	const onCopy = useCallback(() => {
		if (!myCode) return;
		void navigator.clipboard?.writeText(myCode).then(
			() => setCopied(true),
			() => undefined,
		);
	}, [myCode]);

	// Known teammates not already on this entity — the click-to-add picks.
	const knownPicks = contacts.filter((c) => !members.some((m) => m.pubkey === c.pubkey));

	return (
		<Popover title={labels.title} onClose={onClose} testId={props.testId ?? "share-dialog"}>
			<div className="bs-share">
				<section className="bs-share__section">
					<h3 className="bs-share__heading">{labels.membersHeading}</h3>
					<ul className="bs-share__members">
						{members.map((m) => (
							<li key={m.pubkey} className="bs-share__member">
								<span className="bs-share__member-name" title={m.fingerprint}>
									{memberName(m, labels.you)}
								</span>
								<span className="bs-share__role">{roleLabel(m.role)}</span>
								{canManage && !m.isSelf && m.role !== OWNER ? (
									<button
										type="button"
										className="bs-share__revoke"
										aria-label={labels.revoke}
										data-bs-tooltip={labels.revoke}
										disabled={busy}
										onClick={() => void onRevoke(m.pubkey)}
									>
										<Icon name={IconName.Close} size={14} />
									</button>
								) : null}
							</li>
						))}
					</ul>
				</section>

				{canManage && knownPicks.length > 0 ? (
					<section className="bs-share__section">
						<h3 className="bs-share__heading">{labels.quickAddHeading}</h3>
						<div className="bs-share__contacts">
							{knownPicks.map((c) => (
								<button
									key={c.pubkey}
									type="button"
									className="bs-share__contact"
									disabled={busy}
									onClick={() => void onAddContact(c.pubkey)}
								>
									<Icon name={IconName.Plus} size={12} />
									{c.displayName}
								</button>
							))}
						</div>
					</section>
				) : null}

				{canManage ? (
					<section className="bs-share__section">
						<h3 className="bs-share__heading">{labels.addHeading}</h3>
						<div className="bs-share__add">
							<input
								className="bs-share__code-input"
								value={code}
								placeholder={labels.codePlaceholder}
								aria-label={labels.codePlaceholder}
								disabled={busy}
								onChange={(e) => setCode(e.target.value)}
								onKeyDown={(e) => {
									// Enter submits the single-field add, matching every other
									// commit-on-Enter input in the product.
									if (e.key === "Enter" && !busy && code.trim().length > 0) {
										e.preventDefault();
										void onAdd();
									}
								}}
							/>
							<SelectMenu<RosterRole>
								options={[
									{ value: EDITOR, label: labels.canEdit },
									{ value: VIEWER, label: labels.canView },
								]}
								value={role}
								onChange={setRole}
								ariaLabel={labels.addHeading}
							/>
							<button
								type="button"
								className="bs-btn"
								data-bs-primary=""
								disabled={busy || code.trim().length === 0}
								onClick={() => void onAdd()}
							>
								{labels.add}
							</button>
						</div>
					</section>
				) : null}

				<section className="bs-share__section">
					<h3 className="bs-share__heading">{labels.inviteHeading}</h3>
					{myCode ? (
						<div className="bs-share__invite">
							<input
								className="bs-share__code-input"
								value={myCode}
								readOnly
								aria-label={labels.inviteHeading}
							/>
							<button type="button" className="bs-btn bs-btn--neutral" onClick={onCopy}>
								{copied ? labels.copied : labels.copy}
							</button>
						</div>
					) : (
						<button type="button" className="bs-btn bs-btn--neutral" onClick={() => void onGetCode()}>
							{labels.getCode}
						</button>
					)}
					<p className="bs-share__hint">{labels.inviteHint}</p>
				</section>

				{error ? (
					<p className="bs-share__error" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Popover>
	);
}

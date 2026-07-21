/**
 * Compose / reply / forward dialog (Mailbox-4). A thin form over a
 * `ComposeSeed`; Send dispatches the `send` intent (never a Mailbox API —
 * doc 53 §Sending) with the seed's stable `submissionId`, so retrying a
 * failed dispatch can never double-send. The From picker is the shared
 * fancy-menus runtime (no native select).
 */

import {
	CompactEditor,
	type CompactEditorHandle,
	type CompactEditorPayload,
} from "@brainstorm-os/editor";
import { MenuAlign } from "@brainstorm-os/sdk/menus";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { Popover, PopoverSize } from "@brainstorm-os/sdk/popover";
import { TextSurfaceKind, spellcheckForSurface } from "@brainstorm-os/sdk/spellcheck";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement, MouseEvent as ReactMouseEvent } from "react";
import { t } from "../i18n";
import { type ComposeSeed, parseRecipients, sendPayloadFromSeed } from "../logic/compose";
import type { AccountView } from "../types/mail-view";

export type ComposerProps = {
	seed: ComposeSeed;
	accounts: readonly AccountView[];
	onClose: () => void;
	/** Dispatch the validated `send` intent payload. Resolves when the
	 *  shell-side submission finished (or dedupe matched). */
	onSend: (payload: Record<string, unknown>) => Promise<void>;
};

export function Composer({ seed, accounts, onClose, onSend }: ComposerProps): ReactElement {
	const [accountRef, setAccountRef] = useState<string>(seed.accountRef ?? accounts[0]?.id ?? "");
	const [to, setTo] = useState(seed.to);
	const [cc, setCc] = useState(seed.cc);
	const [subject, setSubject] = useState(seed.subject);
	const [body, setBody] = useState<CompactEditorPayload | null>(null);
	const [busy, setBusy] = useState(false);
	const editorRef = useRef<CompactEditorHandle>(null);
	// Seed once — the editor is the live draft from then on. An HTML quote
	// (reply/forward of an HTML message, Mailbox-11) seeds the rich surface so
	// the quote keeps its formatting; otherwise the plain-text quote seeds.
	const seededRef = useRef(false);
	useEffect(() => {
		if (seededRef.current) return;
		seededRef.current = true;
		if (seed.bodyHtml !== undefined && seed.bodyHtml.length > 0) {
			editorRef.current?.setHtml(seed.bodyHtml);
		} else if (seed.body.length > 0) {
			editorRef.current?.setText(seed.body);
		}
	}, [seed.body, seed.bodyHtml]);
	const [error, setError] = useState<string | null>(null);

	const account = accounts.find((a) => a.id === accountRef) ?? null;
	const canSend = !busy && accountRef.length > 0 && parseRecipients(to).length > 0;

	const onPickFrom = useCallback(
		(event: ReactMouseEvent<HTMLButtonElement>) => {
			const button = event.currentTarget;
			const items: AnchoredMenuItem[] = accounts.map((a) => ({
				label: a.displayName.length > 0 ? `${a.displayName} <${a.address}>` : a.address,
				onSelect: () => setAccountRef(a.id),
			}));
			const r = button.getBoundingClientRect();
			openAnchoredMenu({ x: r.left, y: r.bottom + 4 }, items, {
				menuLabel: t("compose.from"),
				anchor: button,
				align: MenuAlign.Start,
			});
		},
		[accounts],
	);

	const submit = (event: FormEvent): void => {
		event.preventDefault();
		if (!canSend) return;
		const payload = sendPayloadFromSeed(
			{ ...seed, to, cc, subject, body: body?.text ?? "" },
			accountRef,
			body !== null && !body.isEmpty ? body.html : undefined,
		);
		if (!payload) return;
		setBusy(true);
		setError(null);
		onSend(payload)
			.then(() => onClose())
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
				setBusy(false);
			});
	};

	return (
		<Popover
			title={t("compose.title")}
			onClose={onClose}
			size={PopoverSize.Medium}
			testId="mb-composer"
		>
			<form className="mb-compose" onSubmit={submit}>
				{accounts.length > 1 ? (
					<div className="mb-compose__field">
						<span className="mb-compose__label">{t("compose.from")}</span>
						<button
							type="button"
							className="bs-input mb-compose__from"
							onClick={onPickFrom}
							aria-haspopup="menu"
							disabled={busy}
						>
							{account ? account.address : t("compose.from.pick")}
						</button>
					</div>
				) : null}
				<label className="mb-compose__field">
					<span className="mb-compose__label">{t("compose.to")}</span>
					<input
						className="bs-input"
						type="text"
						value={to}
						onChange={(e) => setTo(e.target.value)}
						placeholder={t("compose.to.placeholder")}
						spellCheck={spellcheckForSurface(TextSurfaceKind.Code)}
						disabled={busy}
						required
					/>
				</label>
				<label className="mb-compose__field">
					<span className="mb-compose__label">{t("compose.cc")}</span>
					<input
						className="bs-input"
						type="text"
						value={cc}
						onChange={(e) => setCc(e.target.value)}
						spellCheck={spellcheckForSurface(TextSurfaceKind.Code)}
						disabled={busy}
					/>
				</label>
				<label className="mb-compose__field">
					<span className="mb-compose__label">{t("compose.subject")}</span>
					<input
						className="bs-input"
						type="text"
						value={subject}
						onChange={(e) => setSubject(e.target.value)}
						spellCheck={spellcheckForSurface(TextSurfaceKind.Prose)}
						disabled={busy}
					/>
				</label>
				<div className="mb-compose__field">
					<span className="mb-compose__label" id="mb-compose-body-label">
						{t("compose.body")}
					</span>
					{/* Rich body (Mailbox-11): the shared CompactEditor surface — sends
					    multipart/alternative (payload.html + payload.text). Enter stays a
					    paragraph break; Send is the explicit submit. */}
					<CompactEditor
						ref={editorRef}
						className="mb-compose__editor"
						ariaLabel={t("compose.body")}
						submitOnEnter={false}
						disabled={busy}
						onChange={setBody}
					/>
				</div>
				{error ? (
					<p className="mb-compose__error" role="alert">
						{t("compose.error", { message: error })}
					</p>
				) : null}
				<div className="mb-compose__actions">
					<button type="button" className="bs-btn bs-btn--secondary" onClick={onClose} disabled={busy}>
						{t("compose.cancel")}
					</button>
					<button type="submit" className="bs-btn" data-bs-primary disabled={!canSend}>
						{busy ? t("compose.sending") : t("compose.send")}
					</button>
				</div>
			</form>
		</Popover>
	);
}

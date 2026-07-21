/** Reading-pane attachment chips (Mailbox-6). Sync only ever stored the
 *  server's part metadata, so a chip renders with nothing downloaded; the
 *  bytes move on the user's click, land in a `File/v1`, and the message
 *  opens through the shared `open` verb (Files/Preview decide the viewer).
 *
 *  `mail.fetchAttachment` is idempotent per part, so a chip clicked twice —
 *  or clicked again in a later session — costs one cheap round-trip and
 *  reuses the existing file rather than re-downloading. */

import { formatBytes } from "@brainstorm/sdk/format-bytes";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { type ReactElement, useState } from "react";
import { t } from "../i18n";
import type { MailAttachmentPart } from "../types/mail-view";

export type AttachmentChipsProps = {
	parts: readonly MailAttachmentPart[];
	/** Fetches (or replays) the part and opens the resulting file. Absent ⇒
	 *  attachment fetching is unavailable, so chips render inert as a record
	 *  of what the message carries. */
	onOpen?: (partRef: string) => Promise<void>;
};

type ChipState = { busy: boolean; error: boolean };

export function AttachmentChips({ parts, onOpen }: AttachmentChipsProps): ReactElement | null {
	const [states, setStates] = useState<Record<string, ChipState>>({});
	if (parts.length === 0) return null;

	const open = async (partRef: string): Promise<void> => {
		if (!onOpen || states[partRef]?.busy) return;
		setStates((prev) => ({ ...prev, [partRef]: { busy: true, error: false } }));
		try {
			await onOpen(partRef);
			setStates((prev) => ({ ...prev, [partRef]: { busy: false, error: false } }));
		} catch {
			// The chip carries its own failure — a whole-pane error banner would
			// bury which of several attachments actually failed.
			setStates((prev) => ({ ...prev, [partRef]: { busy: false, error: true } }));
		}
	};

	return (
		<div className="mb-attachments">
			<span className="mb-attachments__label">{t("reading.attachments")}</span>
			<ul className="mb-attachments__list">
				{parts.map((part) => {
					const state = states[part.partRef];
					const size = typeof part.sizeBytes === "number" ? formatBytes(part.sizeBytes) : "";
					return (
						<li key={part.partRef}>
							<button
								type="button"
								className={`mb-attachment${state?.error ? " is-error" : ""}`}
								onClick={() => void open(part.partRef)}
								disabled={!onOpen || state?.busy === true}
								title={part.filename}
							>
								<Icon name={IconName.KindFile} className="mb-attachment__icon" />
								<span className="mb-attachment__name">{part.filename}</span>
								{size ? <span className="mb-attachment__size">{size}</span> : null}
								{state?.busy ? (
									<span className="mb-attachment__status">{t("reading.attachments.fetching")}</span>
								) : null}
								{state?.error ? (
									<span className="mb-attachment__status">{t("reading.attachments.failed")}</span>
								) : null}
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

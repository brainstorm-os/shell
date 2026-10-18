/**
 * The quick-capture stream on today's entry (9.16.14): one field that
 * appends a line to the day; a `#collection` tag files the line as a new
 * object in that collection instead (see `logic/capture-filing`). Enter
 * submits through the native form — no key handling of our own.
 */

import { type FormEvent, type ReactElement, useState } from "react";
import { CaptureOutcome } from "../logic/capture-filing";
import { type JournalI18nKey, t } from "../logic/journal-i18n";

const OUTCOME_MESSAGE: Partial<Record<CaptureOutcome, JournalI18nKey>> = {
	[CaptureOutcome.Appended]: "captureAppended",
	[CaptureOutcome.Filed]: "captureFiled",
	[CaptureOutcome.FiledWithoutMembership]: "captureFiledWithoutMembership",
	[CaptureOutcome.FileFailed]: "captureFileFailed",
	[CaptureOutcome.Unavailable]: "captureUnavailable",
};

export type QuickCaptureResult = { outcome: CaptureOutcome; collectionName: string | null };

export function QuickCapture({
	onCapture,
	collectionCount,
}: {
	onCapture: (raw: string) => Promise<QuickCaptureResult>;
	/** How many collections a tag can file into — drives the hint. */
	collectionCount: number;
}): ReactElement {
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");

	const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		if (busy || draft.trim() === "") return;
		setBusy(true);
		try {
			const result = await onCapture(draft);
			const key = OUTCOME_MESSAGE[result.outcome];
			setStatus(key ? t(key, { collection: result.collectionName ?? "" }) : "");
			if (result.outcome !== CaptureOutcome.Unavailable) setDraft("");
		} finally {
			setBusy(false);
		}
	};

	return (
		<form
			className="journal__capture"
			data-testid="journal-capture"
			onSubmit={(event) => void submit(event)}
		>
			<input
				type="text"
				className="bs-input journal__capture-input"
				data-testid="journal-capture-input"
				aria-label={t("captureLabel")}
				placeholder={collectionCount > 0 ? t("capturePlaceholderTagged") : t("capturePlaceholder")}
				value={draft}
				disabled={busy}
				onChange={(event) => setDraft(event.target.value)}
			/>
			<button
				type="submit"
				className="bs-btn bs-btn--secondary journal__capture-submit"
				disabled={busy || draft.trim() === ""}
			>
				{t("captureSubmit")}
			</button>
			<p className="journal__capture-status" role="status" data-testid="journal-capture-status">
				{status}
			</p>
		</form>
	);
}

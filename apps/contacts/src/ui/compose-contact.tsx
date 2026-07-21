/**
 * "New contact" compose popover — creation goes through the shared `<Popover>`
 * form like every other app (the Tasks / Bookmarks compose pattern). The
 * entity is created only on submit, so cancelling never leaves an "Unnamed"
 * ghost row behind. Name is required; company / email / phone are optional
 * seeds (everything else is edited in the properties panel afterwards).
 */

import { Popover } from "@brainstorm-os/sdk/popover";
import { useId, useState } from "react";
import type { ChangeEvent, FormEvent, ReactElement } from "react";
import { t } from "../i18n";
import { type ComposeDraft, composeDraftValid, emptyComposeDraft } from "../logic/compose";

export type ComposeContactProps = {
	onCreate: (draft: ComposeDraft) => void;
	onClose: () => void;
};

type ComposeFieldProps = {
	label: string;
	value: string;
	placeholder: string;
	type?: "text" | "email" | "tel";
	required?: boolean;
	autoFocus?: boolean;
	testId?: string;
	onChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

function ComposeField({
	label,
	value,
	placeholder,
	type = "text",
	required = false,
	autoFocus = false,
	testId,
	onChange,
}: ComposeFieldProps): ReactElement {
	return (
		<label className="contacts-compose__field">
			<span className="contacts-compose__label">{label}</span>
			<input
				className="bs-input contacts-compose__input"
				type={type}
				value={value}
				placeholder={placeholder}
				aria-required={required}
				// biome-ignore lint/a11y/noAutofocus: the popover exists to receive this input — focusing the name field is the compose contract
				autoFocus={autoFocus}
				data-testid={testId}
				onChange={onChange}
			/>
		</label>
	);
}

export function ComposeContact({ onCreate, onClose }: ComposeContactProps): ReactElement {
	const formId = useId();
	const [draft, setDraft] = useState<ComposeDraft>(emptyComposeDraft);
	const valid = composeDraftValid(draft);

	const set =
		(key: keyof ComposeDraft) =>
		(event: ChangeEvent<HTMLInputElement>): void =>
			setDraft((d) => ({ ...d, [key]: event.target.value }));

	const submit = (event: FormEvent): void => {
		event.preventDefault();
		if (valid) onCreate(draft);
	};

	return (
		<Popover
			title={t("compose.title")}
			onClose={onClose}
			testId="contacts-compose"
			footer={
				<div className="contacts-compose__actions">
					<button type="button" className="bs-btn bs-btn--neutral" onClick={onClose}>
						{t("compose.cancel")}
					</button>
					<button
						type="submit"
						form={formId}
						className="bs-btn"
						data-bs-primary=""
						disabled={!valid}
						data-testid="contacts-compose-create"
					>
						{t("compose.create")}
					</button>
				</div>
			}
		>
			<form id={formId} className="contacts-compose" onSubmit={submit}>
				<ComposeField
					label={t("compose.name.label")}
					value={draft.name}
					placeholder={t("compose.name.placeholder")}
					required
					autoFocus
					testId="contacts-compose-name"
					onChange={set("name")}
				/>
				<ComposeField
					label={t("compose.company.label")}
					value={draft.company}
					placeholder={t("compose.company.placeholder")}
					onChange={set("company")}
				/>
				<ComposeField
					label={t("compose.email.label")}
					value={draft.email}
					placeholder={t("compose.email.placeholder")}
					type="email"
					onChange={set("email")}
				/>
				<ComposeField
					label={t("compose.phone.label")}
					value={draft.phone}
					placeholder={t("compose.phone.placeholder")}
					type="tel"
					onChange={set("phone")}
				/>
			</form>
		</Popover>
	);
}

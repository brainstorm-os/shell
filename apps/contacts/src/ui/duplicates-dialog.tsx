/**
 * "Review duplicates" dialog (F-158) — rides the shared `<Popover>` like the
 * compose / delete-confirm dialogs. Two steps in one popover: the GROUP LIST
 * (every candidate group, strongest evidence + worst offenders first) and the
 * MERGE VIEW for one group (pick the survivor — default: most complete /
 * oldest — then merge). The field-level union is computed here via the pure
 * `planMergePatch`; the caller runs the actual merge (shell `entities.merge`
 * in vault mode, the in-memory apply in demo mode).
 *
 * Keyboard path: the popover closes on Escape; the survivor picker is a
 * native radio group (arrow keys move the choice); Review / Back / Merge are
 * plain buttons on the tab order. The merge button is the form's default, so
 * Enter in the radio group merges.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { Popover } from "@brainstorm-os/sdk/popover";
import { useId, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { plural, t } from "../i18n";
import { type DuplicateGroupView, DuplicateMatchKind, planMergePatch } from "../logic/duplicates";
import { personInitials } from "../logic/person-view";
import type { Person } from "../types/person";

export type DuplicatesDialogProps = {
	groups: DuplicateGroupView[];
	companyNameOf: (id: string | null) => string | null;
	onMerge: (survivorId: string, loserIds: string[], patch: Record<string, unknown>) => void;
	onClose: () => void;
};

function matchLabel(kind: DuplicateMatchKind): string {
	return kind === DuplicateMatchKind.Email
		? t("duplicates.match.email")
		: t("duplicates.match.name");
}

function personSecondary(person: Person, companyName: string | null): string {
	return [person.role, companyName, person.emails[0]].filter(Boolean).join(" · ");
}

type GroupRowProps = {
	view: DuplicateGroupView;
	onReview: () => void;
};

function GroupRow({ view, onReview }: GroupRowProps): ReactElement {
	const first = view.persons[0];
	const name = first?.name || t("row.noName");
	return (
		<li className="contacts-dups__group">
			<span className="contacts-row__avatar" aria-hidden="true">
				{personInitials(first?.name ?? "") || <Icon name={IconName.Entity} size={16} />}
			</span>
			<span className="contacts-dups__group-text">
				<span className="contacts-dups__group-name">{name}</span>
				<span className="contacts-dups__group-meta">
					{plural(
						view.persons.length,
						"duplicates.group.members.one",
						"duplicates.group.members.other",
						{ count: view.persons.length },
					)}
					{" · "}
					{matchLabel(view.group.kind)}
				</span>
			</span>
			<button
				type="button"
				className="bs-btn bs-btn--neutral"
				data-testid="contacts-dups-review"
				onClick={onReview}
			>
				{t("duplicates.group.review")}
			</button>
		</li>
	);
}

type MergeViewProps = {
	view: DuplicateGroupView;
	formId: string;
	survivorId: string;
	companyNameOf: (id: string | null) => string | null;
	onPickSurvivor: (id: string) => void;
	onSubmit: (event: FormEvent) => void;
};

function MergeView({
	view,
	formId,
	survivorId,
	companyNameOf,
	onPickSurvivor,
	onSubmit,
}: MergeViewProps): ReactElement {
	return (
		<form id={formId} className="contacts-dups__merge" onSubmit={onSubmit}>
			<fieldset className="contacts-dups__fieldset">
				<legend className="contacts-dups__legend">{t("duplicates.survivor.legend")}</legend>
				{view.persons.map((person) => (
					<label
						key={person.id}
						className={
							person.id === survivorId
								? "contacts-dups__member contacts-dups__member--keep"
								: "contacts-dups__member"
						}
					>
						<input
							type="radio"
							name={`${formId}-survivor`}
							value={person.id}
							checked={person.id === survivorId}
							onChange={() => onPickSurvivor(person.id)}
						/>
						<span className="contacts-row__avatar" aria-hidden="true">
							{personInitials(person.name) || <Icon name={IconName.Entity} size={16} />}
						</span>
						<span className="contacts-dups__member-text">
							<span className="contacts-dups__group-name">{person.name || t("row.noName")}</span>
							{personSecondary(person, companyNameOf(person.companyId)) && (
								<span className="contacts-dups__group-meta">
									{personSecondary(person, companyNameOf(person.companyId))}
								</span>
							)}
						</span>
						{person.id === view.defaultSurvivorId && (
							<span className="contacts-dups__badge">{t("duplicates.survivor.suggested")}</span>
						)}
					</label>
				))}
			</fieldset>
			<p className="contacts-dups__hint">{t("duplicates.survivor.hint")}</p>
		</form>
	);
}

export function DuplicatesDialog({
	groups,
	companyNameOf,
	onMerge,
	onClose,
}: DuplicatesDialogProps): ReactElement {
	const formId = useId();
	const [openIndex, setOpenIndex] = useState<number | null>(null);
	const [survivorId, setSurvivorId] = useState<string | null>(null);

	const openView = openIndex !== null ? (groups[openIndex] ?? null) : null;
	const effectiveSurvivor =
		openView &&
		(survivorId && openView.persons.some((p) => p.id === survivorId)
			? survivorId
			: openView.defaultSurvivorId);

	const backToList = (): void => {
		setOpenIndex(null);
		setSurvivorId(null);
	};

	const submit = (event: FormEvent): void => {
		event.preventDefault();
		if (!openView || !effectiveSurvivor) return;
		const survivor = openView.persons.find((p) => p.id === effectiveSurvivor);
		if (!survivor) return;
		const losers = openView.persons.filter((p) => p.id !== effectiveSurvivor);
		onMerge(
			survivor.id,
			losers.map((l) => l.id),
			planMergePatch(survivor, losers),
		);
	};

	return (
		<Popover
			title={t("duplicates.title")}
			onClose={onClose}
			testId="contacts-duplicates"
			footer={
				openView ? (
					<div className="contacts-dups__actions">
						<button type="button" className="bs-btn bs-btn--neutral" onClick={backToList}>
							{t("duplicates.back")}
						</button>
						<button
							type="submit"
							form={formId}
							className="bs-btn"
							data-bs-primary=""
							data-testid="contacts-dups-merge"
						>
							{t("duplicates.merge", { count: openView.persons.length })}
						</button>
					</div>
				) : (
					<div className="contacts-dups__actions">
						<button type="button" className="bs-btn bs-btn--neutral" onClick={onClose}>
							{t("duplicates.close")}
						</button>
					</div>
				)
			}
		>
			{openView ? (
				<MergeView
					view={openView}
					formId={formId}
					survivorId={effectiveSurvivor ?? openView.defaultSurvivorId}
					companyNameOf={companyNameOf}
					onPickSurvivor={setSurvivorId}
					onSubmit={submit}
				/>
			) : (
				<>
					<p className="contacts-dups__intro">{t("duplicates.intro")}</p>
					{groups.length === 0 ? (
						<p className="contacts-dups__empty">{t("duplicates.empty")}</p>
					) : (
						<ul className="contacts-dups__groups">
							{groups.map((view, index) => (
								<GroupRow
									key={view.persons[0]?.id ?? String(index)}
									view={view}
									onReview={() => {
										setSurvivorId(null);
										setOpenIndex(index);
									}}
								/>
							))}
						</ul>
					)}
				</>
			)}
		</Popover>
	);
}

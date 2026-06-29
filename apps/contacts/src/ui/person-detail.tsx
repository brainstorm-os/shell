/**
 * Person detail pane — the contact "card" shown in the content column of the
 * two-pane layout: avatar + editable name, contact methods (email / phone),
 * company + role, next-birthday, related people, and the editable property
 * inspector (the SHARED `PropertiesPanel` as a glass overlay). The card body
 * is the app's own presentation; the property GRID is never hand-rolled — it
 * goes through the shared cells. Opening the company / a related person
 * routes an `open` intent to its owning app.
 */

import type { PropertiesService } from "@brainstorm/sdk-types";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { type EntityTitleSource, PropertiesProvider } from "@brainstorm/sdk/property-ui";
import { useMemo, useState } from "react";
import { t } from "../i18n";
import {
	type NextBirthday,
	type NextYearly,
	nextAnniversary,
	nextBirthday,
} from "../logic/birthday";
import { personInitials } from "../logic/person-view";
import type { Person } from "../types/person";
import { PersonPropertiesPanel } from "./person-properties-panel";

export type RelatedRef = { id: string; name: string };

// The no-selection state is `{ id: null }`, NOT bare `null`: the shared
// NavButtons / NavHistory contract reserves JS `null` as the "nothing to
// apply" sentinel that `back()`/`forward()` return at the ends of the stack —
// a `null` location is swallowed on Back, so you never return to the list.
export type Location = { id: string | null };

export type PersonDetailProps = {
	person: Person;
	companyName: string | null;
	related: RelatedRef[];
	now: number;
	properties: PropertiesService | null;
	/** Live vault title lookup for the company / related-people picker cells. */
	entityTitleSource: EntityTitleSource;
	showProperties: boolean;
	onToggleProperties: () => void;
	onRenamePerson: (name: string) => void;
	onPatch: (patch: Record<string, unknown>) => void;
	/** Mint a new Company and link it to this person (the picker can only pick
	 *  existing entities). */
	onCreateCompany: (name: string) => void;
	onOpenCompany: () => void;
	onOpenPerson: (id: string) => void;
};

function birthdayLabel(next: NextBirthday): string {
	const base =
		next.daysUntil === 0
			? t("birthday.today")
			: next.daysUntil === 1
				? t("birthday.tomorrow")
				: t("birthday.inDays", { days: next.daysUntil });
	return next.ageTurning !== null
		? `${base} · ${t("birthday.turning", { age: next.ageTurning })}`
		: base;
}

function anniversaryLabel(next: NextYearly): string {
	const base =
		next.daysUntil === 0
			? t("anniversary.today")
			: next.daysUntil === 1
				? t("anniversary.tomorrow")
				: t("anniversary.inDays", { days: next.daysUntil });
	return next.yearsSince !== null
		? `${base} · ${t("anniversary.years", { years: next.yearsSince })}`
		: base;
}

export function PersonDetail({
	person,
	companyName,
	related,
	now,
	properties,
	entityTitleSource,
	showProperties,
	onToggleProperties,
	onRenamePerson,
	onPatch,
	onCreateCompany,
	onOpenCompany,
	onOpenPerson,
}: PersonDetailProps): React.ReactElement {
	const [companyDraft, setCompanyDraft] = useState<string | null>(null);

	const commitCompany = (): void => {
		const name = (companyDraft ?? "").trim();
		if (name) onCreateCompany(name);
		setCompanyDraft(null);
	};

	// Local controlled name, committed on blur / Enter so each keystroke isn't a
	// vault write. The detail is keyed by person id at the call site, so a fresh
	// person remounts this and re-seeds the draft.
	const [nameDraft, setNameDraft] = useState(person.name);

	const commitName = (): void => {
		const trimmed = nameDraft.trim();
		if (trimmed !== person.name) onRenamePerson(trimmed);
	};

	const birthday = nextBirthday(person.birthday, now);
	const anniversary = nextAnniversary(person.anniversary, now);
	const initials = personInitials(person.name);

	// A stable runtime object — a fresh literal each render would re-create the
	// property store and re-issue the catalog `list()` IPC on every keystroke.
	const propertiesRuntime = useMemo(
		() => (properties ? { services: { properties } } : null),
		[properties],
	);

	return (
		<div className="contacts-detail">
			<div className="contacts-detail__scroll">
				<div className="contacts-detail__card">
					<div className="contacts-detail__avatar" aria-hidden="true">
						{initials || <Icon name={IconName.Entity} size={28} />}
					</div>
					<input
						className="contacts-detail__name-input"
						value={nameDraft}
						placeholder={t("detail.name.placeholder")}
						aria-label={t("detail.name.aria")}
						onChange={(e) => setNameDraft(e.target.value)}
						onBlur={commitName}
						onKeyDown={(e) => {
							// keyboard-exempt
							if (e.key === "Enter") {
								e.preventDefault();
								e.currentTarget.blur();
							}
						}}
					/>
					{(person.role || companyName) && (
						<p className="contacts-detail__subtitle">
							{person.role}
							{person.role && companyName ? " · " : ""}
							{companyName && (
								<button
									type="button"
									className="contacts-detail__company-link"
									onClick={onOpenCompany}
									title={t("detail.openCompany", { name: companyName })}
								>
									{companyName}
								</button>
							)}
						</p>
					)}
					{birthday && (
						<p className="contacts-detail__birthday">
							<Icon name={IconName.KindDate} size={14} />
							{birthdayLabel(birthday)}
						</p>
					)}
					{anniversary && (
						<p className="contacts-detail__birthday">
							<Icon name={IconName.KindDate} size={14} />
							{anniversaryLabel(anniversary)}
						</p>
					)}
					{!companyName &&
						(companyDraft === null ? (
							<button
								type="button"
								className="contacts-detail__add-company"
								onClick={() => setCompanyDraft("")}
							>
								<Icon name={IconName.Plus} size={14} />
								{t("detail.company.add")}
							</button>
						) : (
							<input
								className="contacts-detail__add-company-input"
								value={companyDraft}
								placeholder={t("detail.company.add.placeholder")}
								aria-label={t("detail.company.add")}
								// biome-ignore lint/a11y/noAutofocus: focus the field the click just opened
								autoFocus
								onChange={(e) => setCompanyDraft(e.target.value)}
								onBlur={commitCompany}
								// keyboard-exempt: input-local commit/cancel (Enter blurs to commit,
								// Escape discards) — field-scoped, not an app shortcut. Mirrors the
								// name-field handler above.
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										e.currentTarget.blur();
									} else if (e.key === "Escape") {
										e.preventDefault();
										setCompanyDraft(null);
									}
								}}
							/>
						))}
				</div>

				<section className="contacts-detail__section" aria-label={t("detail.section.contact")}>
					{person.emails.length === 0 && person.phones.length === 0 ? (
						<p className="contacts-detail__empty">{t("detail.empty.contact")}</p>
					) : (
						<ul className="contacts-detail__methods">
							{person.emails.map((email) => (
								<li key={`e:${email}`} className="contacts-detail__method">
									<Icon name={IconName.KindEmail} size={16} />
									<a className="contacts-detail__method-value" href={`mailto:${email}`}>
										{email}
									</a>
								</li>
							))}
							{person.phones.map((phone) => (
								<li key={`p:${phone}`} className="contacts-detail__method">
									<Icon name={IconName.KindPhone} size={16} />
									<a className="contacts-detail__method-value" href={`tel:${phone}`}>
										{phone}
									</a>
								</li>
							))}
						</ul>
					)}
				</section>

				{related.length > 0 && (
					<section className="contacts-detail__section" aria-label={t("detail.section.related")}>
						<h2 className="contacts-detail__section-title">{t("detail.section.related")}</h2>
						<div className="contacts-detail__chips">
							{related.map((ref) => (
								<button
									type="button"
									key={ref.id}
									className="contacts-detail__chip"
									onClick={() => onOpenPerson(ref.id)}
									title={t("detail.openPerson", { name: ref.name })}
								>
									<Icon name={IconName.Entity} size={14} />
									{ref.name}
								</button>
							))}
						</div>
					</section>
				)}

				{person.bio && <p className="contacts-detail__bio">{person.bio}</p>}
			</div>

			{propertiesRuntime ? (
				<PropertiesProvider runtime={propertiesRuntime} entityTitleSource={entityTitleSource}>
					<PersonPropertiesPanel
						person={person}
						open={showProperties}
						onPatch={onPatch}
						onClose={onToggleProperties}
					/>
				</PropertiesProvider>
			) : null}
		</div>
	);
}

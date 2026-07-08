/**
 * Person detail — the contact PAGE in the content column of the two-pane
 * layout, following the Tasks-detail convention every entity page shares:
 * a hero (avatar + editable name + role · company + next-birthday), the
 * contact's properties as an inline block of SHARED property cells at the
 * top, and below it the free-form body in the SAME `BrainstormEditor`
 * (Lexical + Yjs) Notes / Journal / Tasks / Bookmarks use.
 *
 * The property GRID is never hand-rolled — both the inline block and the
 * slide-over inspector render `personPropertyRows` through the shared
 * cells. The legacy `bio` string seeds the body on first open and is
 * cleared after the first real edit (see `PersonBodyEditor`). Opening the
 * company routes an `open` intent to its owning app.
 */

import type { PropertiesService } from "@brainstorm/sdk-types";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { PropertiesPanel } from "@brainstorm/sdk/properties-panel";
import { type EntityTitleSource, PropertiesProvider } from "@brainstorm/sdk/property-ui";
import { useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import {
	type NextBirthday,
	type NextYearly,
	nextAnniversary,
	nextBirthday,
} from "../logic/birthday";
import { personInitials } from "../logic/person-view";
import type { Person } from "../types/person";
import { PersonBodyEditor } from "./person-body-editor";
import { PersonPropertiesPanel, personPropertyRows } from "./person-properties-panel";

// The no-selection state is `{ id: null }`, NOT bare `null`: the shared
// NavButtons / NavHistory contract reserves JS `null` as the "nothing to
// apply" sentinel that `back()`/`forward()` return at the ends of the stack —
// a `null` location is swallowed on Back, so you never return to the list.
export type Location = { id: string | null };

export type PersonDetailProps = {
	person: Person;
	companyName: string | null;
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
	now,
	properties,
	entityTitleSource,
	showProperties,
	onToggleProperties,
	onRenamePerson,
	onPatch,
	onCreateCompany,
	onOpenCompany,
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

	// The legacy `bio` seed is latched ONCE per mount (keyed by person id at
	// the call site): the first-edit patch clears `bio` on the entity, and a
	// re-render with the now-empty bio must not yank `initialEditorState` out
	// from under the still-mounted editor.
	const seedBio = useRef(person.bio).current;
	const migratedRef = useRef(false);
	const onFirstEdit = (): void => {
		if (migratedRef.current) return;
		migratedRef.current = true;
		if (seedBio.trim()) onPatch({ bio: "" });
	};

	// A stable runtime object — a fresh literal each render would re-create the
	// property store and re-issue the catalog `list()` IPC on every keystroke.
	const propertiesRuntime = useMemo(
		() => (properties ? { services: { properties } } : null),
		[properties],
	);

	const inlineRows = personPropertyRows(person, onPatch);

	return (
		<div className="contacts-detail">
			<div className="contacts-detail__scroll">
				<div className="contacts-detail__page">
					<div className="contacts-detail__card">
						<div className="contacts-detail__avatar" aria-hidden="true">
							{initials || <Icon name={IconName.Entity} size={28} />}
						</div>
						<input
							className="contacts-detail__name-input bs-input bs-input--lg"
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
									className="contacts-detail__add-company-input bs-input bs-input--sm"
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

					{propertiesRuntime ? (
						<div className="contacts-detail__properties">
							<PropertiesProvider runtime={propertiesRuntime} entityTitleSource={entityTitleSource}>
								<PropertiesPanel
									title={t("detail.properties.title")}
									rows={inlineRows}
									entityId={person.id}
									hideHeader
								/>
							</PropertiesProvider>
						</div>
					) : null}

					<div className="contacts-detail__body">
						<PersonBodyEditor
							personId={person.id}
							{...(seedBio.trim() ? { seedBio } : {})}
							onFirstEdit={onFirstEdit}
						/>
					</div>
				</div>
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

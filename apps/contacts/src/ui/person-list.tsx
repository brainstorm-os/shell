/**
 * Person sidebar — the persistent left panel of the two-pane layout (the
 * Tasks / Notes / Journal convention): search, an "Upcoming birthdays" strip,
 * and the alphabetically grouped contact list. Selecting a row drives the
 * detail pane on the right; every row also carries the shared object menu
 * (right-click + hover ⋯) so Open / Delete are reachable from the list.
 */

import { EmptyState } from "@brainstorm/sdk/empty-state";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import {
	type ObjectMenuContext,
	ObjectMenuTrigger,
	openAnchoredMenu,
} from "@brainstorm/sdk/object-menu";
import { useMemo, useRef } from "react";
import { type ContactsI18nKey, t } from "../i18n";
import { type NextBirthday, isBirthdaySoon, nextBirthday } from "../logic/birthday";
import {
	CONTACTS_GROUPINGS,
	CONTACTS_SORTINGS,
	ContactsGrouping,
	ContactsSorting,
	type PersonViewResolvers,
	filterPersons,
	groupPersons,
	personInitials,
} from "../logic/person-view";
import type { Person } from "../types/person";

const BIRTHDAY_WINDOW_DAYS = 30;

export type PersonSidebarProps = {
	persons: Person[];
	query: string;
	now: number;
	demo: boolean;
	open: boolean;
	activeId: string | null;
	companyNameOf: (id: string | null) => string | null;
	grouping: ContactsGrouping;
	sorting: ContactsSorting;
	/** Shared object-menu context for a row (right-click + hover ⋯). */
	menuContextFor: (person: Person) => ObjectMenuContext;
	onQueryChange: (q: string) => void;
	onSelect: (id: string) => void;
	onCreate: () => void;
	onSetGrouping: (grouping: ContactsGrouping) => void;
	onSetSorting: (sorting: ContactsSorting) => void;
};

/** i18n key for each grouping axis's display label. */
const GROUP_LABEL_KEY: Record<ContactsGrouping, ContactsI18nKey> = {
	[ContactsGrouping.FirstLetter]: "list.group.firstLetter",
	[ContactsGrouping.Company]: "list.group.company",
	[ContactsGrouping.Role]: "list.group.role",
	[ContactsGrouping.None]: "list.group.none",
};

/** i18n key for each sort axis's display label. */
const SORT_LABEL_KEY: Record<ContactsSorting, ContactsI18nKey> = {
	[ContactsSorting.Name]: "list.sort.name",
	[ContactsSorting.Company]: "list.sort.company",
};

function rowSecondary(person: Person, companyName: string | null): string {
	return person.role || companyName || person.emails[0] || "";
}

function birthdayBadge(next: NextBirthday): string {
	if (next.daysUntil === 0) return t("birthday.today");
	if (next.daysUntil === 1) return t("birthday.tomorrow");
	return t("birthday.inDays", { days: next.daysUntil });
}

type PersonRowProps = {
	person: Person;
	secondary: string;
	active: boolean;
	onSelect: (id: string) => void;
};

function PersonRow({ person, secondary, active, onSelect }: PersonRowProps) {
	return (
		<button
			type="button"
			className={active ? "contacts-row contacts-row--active" : "contacts-row"}
			aria-current={active ? "true" : undefined}
			onClick={() => onSelect(person.id)}
		>
			<span className="contacts-row__avatar" aria-hidden="true">
				{personInitials(person.name) || <Icon name={IconName.Entity} size={16} />}
			</span>
			<span className="contacts-row__text">
				<span className="contacts-row__name">{person.name || t("row.noName")}</span>
				{secondary && <span className="contacts-row__secondary">{secondary}</span>}
			</span>
		</button>
	);
}

type AxisPickerProps<T extends string> = {
	axes: readonly T[];
	active: T;
	leadingIcon: IconName;
	labelKeyOf: (axis: T) => ContactsI18nKey;
	captionKey: Extract<ContactsI18nKey, "list.groupBy" | "list.sortBy">;
	menuLabelKey: Extract<ContactsI18nKey, "list.groupBy.menuLabel" | "list.sortBy.menuLabel">;
	onSet: (axis: T) => void;
};

// Mirrors the Tasks app's Group/Sort triggers: a leading glyph + label, no
// trailing caret, sharing the borderless toggle chrome.
function AxisPicker<T extends string>({
	axes,
	active,
	leadingIcon,
	labelKeyOf,
	captionKey,
	menuLabelKey,
	onSet,
}: AxisPickerProps<T>): React.ReactElement {
	const buttonRef = useRef<HTMLButtonElement>(null);
	return (
		<button
			ref={buttonRef}
			type="button"
			className="contacts-list__control"
			aria-haspopup="menu"
			onClick={() => {
				const button = buttonRef.current;
				if (!button) return;
				const r = button.getBoundingClientRect();
				openAnchoredMenu(
					{ x: r.left, y: r.bottom + 4 },
					axes.map((axis) => ({
						label: t(labelKeyOf(axis)),
						...(axis === active ? { icon: IconName.Check } : {}),
						onSelect: () => onSet(axis),
					})),
					{ menuLabel: t(menuLabelKey), anchor: button },
				);
			}}
		>
			<Icon name={leadingIcon} size={14} />
			{t(captionKey, { axis: t(labelKeyOf(active)) })}
		</button>
	);
}

export function PersonSidebar({
	persons,
	query,
	now,
	demo,
	open,
	activeId,
	companyNameOf,
	grouping,
	sorting,
	menuContextFor,
	onQueryChange,
	onSelect,
	onCreate,
	onSetGrouping,
	onSetSorting,
}: PersonSidebarProps): React.ReactElement {
	const filtered = useMemo(() => filterPersons(persons, query), [persons, query]);
	const resolvers = useMemo<PersonViewResolvers>(
		() => ({ companyName: companyNameOf }),
		[companyNameOf],
	);
	const groups = useMemo(
		() =>
			groupPersons(filtered, grouping, sorting, resolvers, {
				otherLetter: t("list.group.other"),
				noCompany: t("list.group.noCompany"),
				noRole: t("list.group.noRole"),
			}),
		[filtered, grouping, sorting, resolvers],
	);

	const upcoming = useMemo(() => {
		if (query.trim()) return [];
		return persons
			.map((person) => ({ person, next: nextBirthday(person.birthday, now) }))
			.filter((row): row is { person: Person; next: NextBirthday } =>
				isBirthdaySoon(row.next, BIRTHDAY_WINDOW_DAYS),
			)
			.sort((a, b) => a.next.daysUntil - b.next.daysUntil);
	}, [persons, now, query]);

	return (
		<aside
			id="contacts-sidebar"
			className="contacts__sidebar"
			aria-label={t("sidebar.region")}
			aria-hidden={!open}
			inert={!open ? true : undefined}
		>
			<div className="contacts-list__search bs-input bs-input--sm">
				<Icon name={IconName.Search} size={16} />
				<input
					className="contacts-list__search-input bs-input__control"
					type="search"
					value={query}
					placeholder={t("list.search.placeholder")}
					aria-label={t("list.search.aria")}
					onChange={(e) => onQueryChange(e.target.value)}
				/>
			</div>

			<div className="contacts-list__controls">
				<AxisPicker
					axes={CONTACTS_GROUPINGS}
					active={grouping}
					leadingIcon={IconName.View}
					labelKeyOf={(axis) => GROUP_LABEL_KEY[axis]}
					captionKey="list.groupBy"
					menuLabelKey="list.groupBy.menuLabel"
					onSet={onSetGrouping}
				/>
				<AxisPicker
					axes={CONTACTS_SORTINGS}
					active={sorting}
					leadingIcon={IconName.KindText}
					labelKeyOf={(axis) => SORT_LABEL_KEY[axis]}
					captionKey="list.sortBy"
					menuLabelKey="list.sortBy.menuLabel"
					onSet={onSetSorting}
				/>
			</div>

			{demo && <p className="contacts-list__banner">{t("demo.banner")}</p>}

			<div className="contacts-list__scroll">
				{persons.length === 0 ? (
					<EmptyState
						icon={IconName.Entity}
						title={t("list.empty.title")}
						hint={t("list.empty.blurb")}
						action={
							<button
								type="button"
								className="bs-btn"
								data-bs-primary=""
								onClick={onCreate}
								data-testid="contacts-empty-new"
							>
								{t("list.new")}
							</button>
						}
					/>
				) : filtered.length === 0 ? (
					<p className="contacts-list__no-results">{t("list.noResults", { query })}</p>
				) : (
					<>
						{upcoming.length > 0 && (
							<section className="contacts-list__upcoming" aria-label={t("list.upcomingBirthdays")}>
								<h2 className="contacts-list__group-letter">{t("list.upcomingBirthdays")}</h2>
								{upcoming.map(({ person, next }) => (
									<ObjectMenuTrigger
										key={`b:${person.id}`}
										variant="row"
										moreActionsLabel={t("detail.menu.more")}
										context={() => menuContextFor(person)}
									>
										<button type="button" className="contacts-row" onClick={() => onSelect(person.id)}>
											<span className="contacts-row__avatar contacts-row__avatar--soft" aria-hidden="true">
												{personInitials(person.name) || <Icon name={IconName.Entity} size={16} />}
											</span>
											<span className="contacts-row__text">
												<span className="contacts-row__name">{person.name || t("row.noName")}</span>
												<span className="contacts-row__secondary">{birthdayBadge(next)}</span>
											</span>
											<Icon name={IconName.KindDate} size={14} />
										</button>
									</ObjectMenuTrigger>
								))}
							</section>
						)}

						{groups.map((group) => (
							<section key={group.key} className="contacts-list__group">
								{group.label && <h2 className="contacts-list__group-letter">{group.label}</h2>}
								{group.persons.map((person) => (
									<ObjectMenuTrigger
										key={person.id}
										variant="row"
										moreActionsLabel={t("detail.menu.more")}
										context={() => menuContextFor(person)}
									>
										<PersonRow
											person={person}
											secondary={rowSecondary(person, companyNameOf(person.companyId))}
											active={person.id === activeId}
											onSelect={onSelect}
										/>
									</ObjectMenuTrigger>
								))}
							</section>
						))}
					</>
				)}
			</div>
		</aside>
	);
}

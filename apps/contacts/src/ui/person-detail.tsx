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

import type { PropertiesService } from "@brainstorm-os/sdk-types";
import { CoverPicker, type CoverPickerService } from "@brainstorm-os/sdk/cover-picker";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { IconPicker, type IconUploadService } from "@brainstorm-os/sdk/icon-picker";
import { PropertiesPanel } from "@brainstorm-os/sdk/properties-panel";
import {
	DEFAULT_PROPERTY_UI_LABELS,
	type EntityTitleSource,
	PropertiesProvider,
} from "@brainstorm-os/sdk/property-ui";
import { useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import {
	type NextBirthday,
	type NextYearly,
	nextAnniversary,
	nextBirthday,
} from "../logic/birthday";
import { personInitials } from "../logic/person-view";
import { getBrainstorm } from "../runtime";
import type { Person } from "../types/person";
import { EntityCover, EntityIcon } from "./entity-visuals";
import { PersonBodyEditor } from "./person-body-editor";
import { PersonPropertiesPanel, personPropertyRows } from "./person-properties-panel";

/** Older shells don't expose the vault cover store — the picker's gradient /
 *  colour tabs still work; Image upload rejects (the Bookmarks arrangement). */
const COVERS_UNAVAILABLE: CoverPickerService = {
	uploadBytes: () => Promise.reject(new Error("covers service unavailable")),
	list: () => Promise.resolve([]),
};

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
	/** Cover-picker visibility is owned by the app shell so the object ⋯ menu's
	 *  Add/Change-cover item can open it too (the Notes arrangement). */
	coverPickerOpen: boolean;
	onCoverPickerOpenChange: (open: boolean) => void;
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
	coverPickerOpen,
	onCoverPickerOpenChange,
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

	const [iconPickerOpen, setIconPickerOpen] = useState(false);

	// Universal icon / cover backing services (default-granted caps); absent on
	// older shells — the pickers' upload tabs degrade, everything else works.
	const coversService = useMemo<CoverPickerService>(
		() => getBrainstorm()?.services?.covers ?? COVERS_UNAVAILABLE,
		[],
	);
	const iconUpload = useMemo<IconUploadService | undefined>(() => {
		const icons = getBrainstorm()?.services?.icons;
		if (!icons) return undefined;
		return {
			upload: (filename, bytes) => icons.uploadBytes(filename, bytes),
			list: async () => (await icons.list()).map((e) => ({ url: e.url, thumbUrl: e.thumbUrl })),
		};
	}, []);

	// Stable cover subject — the band re-renders off the explicit `cover` prop.
	const coverSubject = useMemo(() => ({ id: person.id }), [person.id]);

	const inlineRows = personPropertyRows(person, onPatch);

	// Localised "Empty" for unset cells; identity-stable so the provider's
	// context memo doesn't churn (dep is the resolved string, which changes
	// exactly when the locale pack swaps).
	const cellEmptyLabel = t("prop.empty");
	const propertyUiLabels = useMemo(
		() => ({ ...DEFAULT_PROPERTY_UI_LABELS, cellEmpty: cellEmptyLabel }),
		[cellEmptyLabel],
	);

	const content = (
		<div className="contacts-detail">
			<div className="contacts-detail__scroll">
				{person.cover ? (
					<button
						type="button"
						className="contacts-detail__cover"
						aria-label={t("detail.cover.edit")}
						aria-haspopup="dialog"
						aria-expanded={coverPickerOpen}
						onClick={() => onCoverPickerOpenChange(!coverPickerOpen)}
					>
						{/* Slim banner aspect shared with Notes / Bookmarks (16 / 3.5). */}
						<EntityCover subject={coverSubject} cover={person.cover} aspect={16 / 3.5} />
					</button>
				) : null}
				<div className="contacts-detail__page">
					<div className="contacts-detail__card">
						<button
							type="button"
							className="contacts-detail__avatar"
							aria-label={t("detail.icon.edit")}
							aria-haspopup="dialog"
							aria-expanded={iconPickerOpen}
							data-bs-tooltip={t("detail.icon.edit")}
							onClick={() => setIconPickerOpen((open) => !open)}
						>
							{person.icon ? (
								<EntityIcon icon={person.icon} size={40} className="contacts-detail__avatar-icon" />
							) : (
								initials || <Icon name={IconName.Entity} size={28} />
							)}
						</button>
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
							<PropertiesPanel
								title={t("detail.properties.title")}
								rows={inlineRows}
								entityId={person.id}
								hideHeader
								inline
							/>
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
				<PersonPropertiesPanel
					person={person}
					open={showProperties}
					onPatch={onPatch}
					onClose={onToggleProperties}
				/>
			) : null}

			{iconPickerOpen ? (
				<IconPicker
					value={person.icon}
					onChange={(icon) => onPatch({ icon })}
					onClose={() => setIconPickerOpen(false)}
					{...(iconUpload ? { iconUpload } : {})}
				/>
			) : null}

			{coverPickerOpen ? (
				<CoverPicker
					value={person.cover}
					covers={coversService}
					onChange={(cover) => {
						onPatch({ cover });
						onCoverPickerOpenChange(false);
					}}
					onClose={() => onCoverPickerOpenChange(false)}
				/>
			) : null}
		</div>
	);

	// ONE provider for both property surfaces (the inline page block + the
	// slide-over inspector) — one store, one catalog `list()` IPC, not two.
	return propertiesRuntime ? (
		<PropertiesProvider
			runtime={propertiesRuntime}
			entityTitleSource={entityTitleSource}
			labels={propertyUiLabels}
		>
			{content}
		</PropertiesProvider>
	) : (
		content
	);
}

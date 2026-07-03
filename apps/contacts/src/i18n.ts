/**
 * Contacts app i18n manifest. Per
 * §Localization every user-visible string flows through the shared app-side
 * `t()` (`createT` from `@brainstorm/sdk/i18n`) — no bare literals. The
 * app-side `t()` does `{name}` interpolation only (no ICU plurals — that is
 * the renderer catalog's job), so count-sensitive copy is split into
 * semantic keys (today / tomorrow / future) rather than a plural rule.
 */

import { type TParams, createT, plural as sdkPlural } from "@brainstorm/sdk/i18n";

export const CONTACTS_I18N = {
	"app.title": "Contacts",

	"company.untitled": "Untitled company",
	"company.allPeople": "All people",
	"company.backToAll": "Back to all contacts",
	"company.members.one": "{count} person",
	"company.members.other": "{count} people",
	"company.empty": "No contacts at this company yet.",

	"widget.sort.label": "Sort contacts",
	"widget.sort.name": "Name",
	"widget.sort.recent": "Recently added",
	"widget.empty": "No contacts yet.",
	"widget.emptyAction": "Add people",

	"list.search.placeholder": "Search people",
	"list.search.aria": "Search contacts by name, email, phone, or role",
	"list.new": "New contact",
	"list.people": "People",

	"sidebar.region": "Contact list",
	"sidebar.show": "Show contact list",
	"sidebar.hide": "Hide contact list",
	"sidebar.resize": "Resize contact list",

	"placeholder.title": "No contact selected",
	"placeholder.blurb": "Choose a person from the list, or create a new contact.",
	"placeholder.blurb.listHidden": "Show the contact list to browse people, or create a new contact.",

	"compose.title": "New contact",
	"compose.name.label": "Name",
	"compose.name.placeholder": "Full name",
	"compose.company.label": "Company",
	"compose.company.placeholder": "Company name",
	"compose.email.label": "Email",
	"compose.email.placeholder": "name@example.com",
	"compose.phone.label": "Phone",
	"compose.phone.placeholder": "+1 555 0100",
	"compose.create": "Create contact",
	"compose.cancel": "Cancel",

	"menu.open": "Open",
	"menu.openUnavailable": "Open a vault to route this object to its app.",
	"menu.region": "Contact actions",
	"list.empty.title": "No contacts yet",
	"list.empty.blurb": "Add your first person to start your address book.",
	"list.noResults": "No people match “{query}”.",
	"list.group.other": "#",
	"list.upcomingBirthdays": "Upcoming birthdays",

	"list.groupBy": "Group by {axis}",
	"list.groupBy.menuLabel": "Group people by",
	"list.group.firstLetter": "First letter",
	"list.group.company": "Company",
	"list.group.role": "Role",
	"list.group.none": "None",
	"list.group.noCompany": "No company",
	"list.group.noRole": "No role",

	"list.sortBy": "Sort by {axis}",
	"list.sortBy.menuLabel": "Sort people by",
	"list.sort.name": "Name",
	"list.sort.company": "Company",

	"row.noName": "Unnamed",

	"detail.properties.show": "Show properties",
	"detail.properties.hide": "Hide properties",
	"detail.properties.disabledHint": "Select a contact first",
	"detail.properties.title": "Properties",
	"detail.menu.more": "More actions",
	"detail.menu.delete": "Delete contact",
	"detail.name.placeholder": "Name",
	"detail.name.aria": "Contact name",
	"detail.section.contact": "Contact",
	"detail.section.related": "Related people",
	"detail.company.label": "Company",
	"detail.company.add": "Add company",
	"detail.company.add.placeholder": "Company name…",
	"detail.role.label": "Role",
	"detail.empty.contact": "No contact details yet — add an email or phone in the properties panel.",
	"detail.openCompany": "Open {name}",
	"detail.openPerson": "Open {name}",

	"birthday.today": "Birthday today 🎂",
	"birthday.tomorrow": "Birthday tomorrow",
	"birthday.inDays": "Birthday in {days} days",
	"birthday.turning": "turning {age}",

	"anniversary.today": "Anniversary today 🎉",
	"anniversary.tomorrow": "Anniversary tomorrow",
	"anniversary.inDays": "Anniversary in {days} days",
	"anniversary.years": "{years} years",

	"prop.email": "Email",
	"prop.phone": "Phone",
	"prop.role": "Role",
	"prop.birthday": "Birthday",
	"prop.bio": "Notes",
	"prop.company": "Company",
	"prop.related": "Related people",

	"delete.confirm.title": "Delete this contact?",
	"delete.confirm.body": "“{name}” will be moved to the bin. This can't be undone here.",
	"delete.confirm.confirm": "Delete",
	"delete.confirm.cancel": "Cancel",

	"demo.banner": "Preview data — open a vault to manage real contacts.",

	"vcard.import": "Import vCard…",
	"vcard.export": "Export vCard…",
	"vcard.filterName": "vCard",
	"vcard.saveDialogTitle": "Export contacts",
	"vcard.openDialogTitle": "Import contacts",
	"vcard.exportEmpty": "No contacts to export yet.",
	"vcard.exported": "Exported {count} contacts.",
	"vcard.exportFailed": "Couldn't export contacts.",
	"vcard.importNone": "No contacts found in those files.",
	"vcard.imported": "Imported {count} contacts.",
	"vcard.importFailed": "Couldn't import contacts.",
} as const;

export type ContactsI18nKey = keyof typeof CONTACTS_I18N;

export const t = createT(CONTACTS_I18N);

/** Catalog-bound plural — picks `<base>.one` / `<base>.other`. The count
 *  selection lives in the shared helper, not in component code. */
export const plural = (
	count: number,
	oneKey: ContactsI18nKey,
	otherKey: ContactsI18nKey,
	params?: TParams,
): string => sdkPlural(t, count, oneKey, otherKey, params);

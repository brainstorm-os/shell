/**
 * Contacts dashboard widget (Stage 7.3 / 7.3b; iteration 9.12.13(c)). When
 * Contacts is launched as a dashboard widget (`launch.reason === "widget"`),
 * `main.tsx` mounts this instead of the full app — the same bundle, in
 * widget-mode. The one registered widget, `list-contacts`, is a glance list of
 * people with an in-widget sort control; the shell strip above draws the title /
 * open / collapse / ⋯ chrome, and clicking a row opens that person in the full
 * Contacts app via the shared `intent.open`.
 *
 * Mirrors the Notes `recent-notes` widget (the 7.3b reference). Reactive over the
 * shell's live vault-entity index through `useVaultEntities` (never the raw
 * `onChange` — the sanctioned reactivity stack), filtered to `Person/v1`.
 */

import { useVaultEntities } from "@brainstorm/react-yjs";
import { openEntity } from "@brainstorm/sdk";
import { SelectMenu } from "@brainstorm/sdk/select-menu";
import "@brainstorm/sdk/select-menu.css";
import {
	WidgetEmpty,
	type WidgetLaunch,
	WidgetRoot,
	useWidgetVisible,
} from "@brainstorm/sdk/widget";
import { useMemo, useState } from "react";
import { plural, t } from "./i18n";
import { useContactsT } from "./i18n-hooks";
import { getBrainstorm } from "./runtime";
import { PERSON_TYPE } from "./types/person";
import {
	CONTACTS_WIDGET_LIST,
	ContactsSort,
	type WidgetContact,
	shapeContacts,
} from "./widget-data";
import "./widget.css";

/** Server-side narrowing for the widget's entity subscription (F-384) —
 *  module-level so the reference is stable across renders. */
const WIDGET_QUERY = { types: [PERSON_TYPE] } as const;

/** Empty-state CTA (F-381): an entityType-only `open` routes to the type's
 *  registered opener and launches the full Contacts app. */
function openContactsApp(): void {
	const intents = getBrainstorm()?.services?.intents;
	if (!intents) return;
	void intents.dispatch({ verb: "open", payload: { entityType: PERSON_TYPE } });
}

/** Open a person in the full Contacts app through the shared open verb (cap
 *  `intents.dispatch:open`). Mirrors the Notes widget's `openEntityInShell`. */
function openContact(entityId: string): void {
	const intents = getBrainstorm()?.services?.intents;
	if (!intents) return;
	void openEntity(
		{
			services: {
				intents: {
					dispatch: (intent) => intents.dispatch(intent as Parameters<typeof intents.dispatch>[0]),
				},
			},
		},
		{ entityId, entityType: PERSON_TYPE },
	);
}

function ContactsList({
	contacts,
	total,
	sort,
	onSort,
}: {
	contacts: WidgetContact[];
	total: number;
	sort: ContactsSort;
	onSort: (next: ContactsSort) => void;
}) {
	return (
		<div className="contacts-widget">
			<div className="contacts-widget__toolbar">
				<SelectMenu<ContactsSort>
					value={sort}
					onChange={onSort}
					ariaLabel={t("widget.sort.label")}
					options={[
						{ value: ContactsSort.Name, label: t("widget.sort.name") },
						{ value: ContactsSort.Recent, label: t("widget.sort.recent") },
					]}
				/>
				<span className="contacts-widget__count">
					{plural(total, "company.members.one", "company.members.other", { count: total })}
				</span>
			</div>
			{contacts.length === 0 ? (
				<WidgetEmpty
					message={t("widget.empty")}
					actionLabel={t("widget.emptyAction")}
					onAction={openContactsApp}
				/>
			) : (
				<ul className="contacts-widget__list">
					{contacts.map((person) => (
						<li key={person.id}>
							<button
								type="button"
								className="contacts-widget__row"
								onClick={() => openContact(person.id)}
							>
								<span className="contacts-widget__name">{person.name}</span>
								{person.subtitle ? (
									<span className="contacts-widget__subtitle">{person.subtitle}</span>
								) : null}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

export function ContactsWidget({ launch }: { launch: WidgetLaunch }) {
	useContactsT();
	const runtime = getBrainstorm();
	// Reactive over the shell's live vault-entity index — pauses implicitly when
	// the host scrolls the widget off-screen (the surface stops re-rendering).
	useWidgetVisible();
	const [sort, setSort] = useState<ContactsSort>(ContactsSort.Name);
	const { entities } = useVaultEntities(runtime?.services?.vaultEntities ?? null, {
		query: WIDGET_QUERY,
	});

	const { contacts, total } = useMemo(() => shapeContacts(entities, sort), [entities, sort]);

	return (
		<WidgetRoot
			widgets={[
				{
					id: CONTACTS_WIDGET_LIST,
					render: () => <ContactsList contacts={contacts} total={total} sort={sort} onSort={setSort} />,
				},
			]}
			launch={launch}
		/>
	);
}

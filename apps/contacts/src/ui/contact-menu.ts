/**
 * `contactObjectMenuContext` — the single place Contacts assembles the shared
 * cross-app object menu for a person (the header ⋯, the title right-click,
 * and every sidebar row), mirroring Notes' `noteObjectMenuContext`. The menu
 * chrome itself is the shared SDK popup — never a hand-rolled list. The vCard
 * import / export entries ride along as extra items so the ⋯ stays the one
 * catch-all overflow.
 */

import type { Intent } from "@brainstorm-os/sdk-types";
import type {
	ObjectMenuContext,
	ObjectMenuExtraItem,
	ObjectMenuRuntime,
} from "@brainstorm-os/sdk/object-menu";
import { t } from "../i18n";
import type { ContactsRuntime } from "../runtime";
import { PERSON_TYPE, type Person } from "../types/person";

/** Narrow the Contacts runtime to the structural slice the shared menu reads.
 *  Contacts' `IntentsService.dispatch` types its intent as `Omit<Intent,
 *  "source">`; the menu's structural runtime types it as a plain record —
 *  functionally identical (the menu only dispatches `verb: "open"`), so this
 *  is the one boundary cast (the Notes pattern). */
function asObjectMenuRuntime(runtime: ContactsRuntime | null): ObjectMenuRuntime {
	const intents = runtime?.services?.intents;
	const dashboard = runtime?.services?.dashboard;
	return {
		...(runtime?.capabilities ? { capabilities: runtime.capabilities } : {}),
		services: {
			...(intents
				? { intents: { dispatch: (i) => intents.dispatch(i as Omit<Intent, "source">) } }
				: {}),
			...(dashboard ? { dashboard } : {}),
		},
	};
}

export type ContactMenuInput = {
	person: Person;
	runtime: ContactsRuntime | null;
	/** App-owned destructive action — opens the delete confirm. */
	onRemove: () => void;
	/** App-specific entries (vCard import / export) spliced in before Remove. */
	extraItems?: ObjectMenuExtraItem[];
};

export function contactObjectMenuContext({
	person,
	runtime,
	onRemove,
	extraItems,
}: ContactMenuInput): ObjectMenuContext {
	return {
		target: { entityId: person.id, entityType: PERSON_TYPE, label: person.name || t("row.noName") },
		runtime: asObjectMenuRuntime(runtime),
		labels: {
			open: t("menu.open"),
			openUnavailable: t("menu.openUnavailable"),
			remove: t("detail.menu.delete"),
			menuRegion: t("menu.region"),
			moreActions: t("detail.menu.more"),
		},
		...(extraItems && extraItems.length > 0 ? { extraItems } : {}),
		onRemove,
	};
}

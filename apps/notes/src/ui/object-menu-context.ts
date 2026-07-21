/**
 * `noteObjectMenuContext` — the single place Notes builds the shared
 * cross-app object menu's context for one of its objects (a note). Both
 * per-object surfaces (the open note's title in the header, every row in
 * the notes list) go through this so they offer the *same* Open /
 * Pin·Unpin / Delete in the same order with the same labels — the menu
 * itself is rendered by the shared SDK chrome, never a hand-rolled popup.
 *
 * The SDK's `<ObjectMenuTrigger context>` resolves this lazily at open
 * time and pre-fetches the pin state itself; this helper only assembles
 * the descriptor (target + runtime + localised chrome labels + the
 * app-owned destructive Delete). Returning `null` makes the trigger inert
 * (e.g. before the runtime is ready).
 */

import type { Intent } from "@brainstorm-os/sdk-types";
import type {
	CollectionsEntitiesService,
	ObjectMenuContext,
	ObjectMenuExtraItem,
	ObjectMenuRuntime,
} from "@brainstorm-os/sdk/object-menu";
import { t } from "../i18n/t";
import { NOTE_TYPE } from "../store/entities-repository";
import type { NotesBrainstorm } from "../store/runtime";

/** Narrow the Notes runtime to exactly the structural slice the shared
 *  object menu reads (`capabilities` + `intents.dispatch` + the
 *  `dashboard` pin surface). Notes' `IntentsService.dispatch` types its
 *  `verb` as the `IntentVerb` enum; the menu's structural runtime types
 *  it as `string` — functionally identical (the menu only ever dispatches
 *  `verb: "open"`, a valid `IntentVerb`), so this is the one boundary
 *  cast rather than widening the app's strongly-typed service. */
function asObjectMenuRuntime(runtime: NotesBrainstorm): ObjectMenuRuntime {
	return {
		...(runtime.capabilities ? { capabilities: runtime.capabilities } : {}),
		services: {
			intents: {
				dispatch: (i) => runtime.services.intents.dispatch(i as Omit<Intent, "source">),
			},
			...(runtime.services.dashboard ? { dashboard: runtime.services.dashboard } : {}),
		},
	};
}

export type NoteObjectMenuInput = {
	noteId: string;
	noteTitle: string;
	runtime: NotesBrainstorm | null;
	/** App-owned destructive action (delete the note). Omitted → the
	 *  menu shows no Delete entry (e.g. a read-only surface). */
	onRemove?: () => void | Promise<void>;
	/** Collab-C5 — open the share dialog for this note. Shows the "Share…"
	 *  item only when Notes also holds the scarce `sharing.share` cap. */
	onShare?: () => void | Promise<void>;
	/** App-specific entries (Export…) spliced in before Remove. */
	extraItems?: ObjectMenuExtraItem[];
};

export function noteObjectMenuContext({
	noteId,
	noteTitle,
	runtime,
	onRemove,
	onShare,
	extraItems,
}: NoteObjectMenuInput): ObjectMenuContext {
	if (!runtime) return null;
	// 9.3.5.V 7c — cross-app "Add to collection": Lists are vault entities,
	// so any object surfaces the picker through the shared menu. The runtime
	// exposes the full entities service at runtime (Notes types it as the
	// narrower `EntityRecord` mirror, which carries every field the List
	// codec reads); one boundary cast, mirroring `asObjectMenuRuntime` above.
	const entities = runtime.services.entities;
	return {
		target: { entityId: noteId, entityType: NOTE_TYPE, label: noteTitle },
		runtime: asObjectMenuRuntime(runtime),
		labels: {
			open: t("notes.objectMenu.open"),
			pin: t("notes.objectMenu.pin"),
			unpin: t("notes.objectMenu.unpin"),
			share: t("notes.objectMenu.share"),
			remove: t("notes.objectMenu.remove"),
			menuRegion: t("notes.objectMenu.region"),
			moreActions: t("notes.objectMenu.more"),
			addToCollection: t("notes.objectMenu.addToCollection"),
			collectionsRegion: t("notes.objectMenu.collectionsRegion"),
			noCollections: t("notes.objectMenu.noCollections"),
		},
		...(entities
			? {
					collections: {
						service: entities as unknown as CollectionsEntitiesService,
						appId: runtime.app.id,
					},
				}
			: {}),
		...(extraItems && extraItems.length > 0 ? { extraItems } : {}),
		...(onRemove ? { onRemove } : {}),
		...(onShare ? { onShare } : {}),
	};
}

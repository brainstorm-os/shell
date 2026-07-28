/**
 * Inspector "Collections" section — DOM renderer.
 *
 * The pure data half lives in `logic/collections-for-entity.ts`
 * (`collectionsForEntity`, `pickerCandidatesForEntity`). This module is
 * the renderer that paints those rows into the inspector body and wires
 * the buttons to caller-supplied side-effects. Dependency-inverted on
 * purpose — the renderer needs no `state` reference, so vitest in jsdom
 * can drive it with a tiny mock.
 *
 * Lands as part of 9.3.5.U (multi-membership UX).
 */

import { t } from "../i18n";
import {
	MembershipKind,
	collectionsForEntity,
	pickerCandidatesForEntity,
} from "../logic/collections-for-entity";
import type { InMemoryEntities } from "../logic/in-memory-entities";
import type { List } from "../types/list";

/** UI strings — English defaults; an app may swap them in for `t()`
 *  output when shell-wide i18n lands. */
export const MEMBERSHIP_BADGE_LABEL: Record<MembershipKind, string> = {
	[MembershipKind.Source]: "from query",
	[MembershipKind.Include]: "added",
	[MembershipKind.Excluded]: "excluded",
};

/** Everything the renderer needs from the host app, wired as a single
 *  bag so the renderer stays a pure DOM-producing function. */
export type InspectorCollectionsBindings = {
	entityId: string;
	lists: ReadonlyArray<List>;
	db: InMemoryEntities;
	isVaultDerivedListId: (listId: string) => boolean;
	/** Paint the list's icon at the given size, or `null` when the list has
	 *  no own icon. Per [[feedback_no_default_type_icon_fallback]] the
	 *  callback returns nothing in that case so the row's flex gap
	 *  collapses around the missing slot — no sized empty box. */
	createListIcon: (list: List, size: number) => HTMLElement | null;
	createCloseIcon: (size: number) => SVGElement | HTMLElement;
	createPlusIcon: (size: number) => SVGElement | HTMLElement;
	/** Click on a list row → host activates that list. */
	onSelectList: (listId: string) => void;
	/** Click ✕ on a non-excluded row → host removes; on an excluded row → host adds back. */
	onToggleEntityInList: (listId: string, add: boolean) => void;
	/** Click "+ Add to collection" → host opens the picker, anchored at `point`. */
	onAddRequest: (point: { x: number; y: number }) => void;
};

/** Pin-point IDs for the renderer's structural DOM. Tests + Playwright
 *  consume these; CSS keeps using BEM classes for styling. */
export const INSPECTOR_COLLECTIONS_TESTID = "db-inspector-collections";
export const INSPECTOR_ADD_TO_COLLECTION_TESTID = "db-inspector-add-to-collection";

export function renderInspectorCollections(
	bindings: InspectorCollectionsBindings,
	labels: Partial<Record<MembershipKind, string>> = {},
): HTMLElement {
	const badgeLabels = { ...MEMBERSHIP_BADGE_LABEL, ...labels };

	const section = document.createElement("section");
	section.className = "db-inspector__collections";
	section.dataset.testid = INSPECTOR_COLLECTIONS_TESTID;

	const header = document.createElement("h3");
	header.className = "db-inspector__section-title";
	header.textContent = t("brainstorm.database.collections.title");
	section.appendChild(header);

	const memberships = collectionsForEntity(bindings.entityId, bindings.lists, bindings.db);

	if (memberships.length === 0) {
		const empty = document.createElement("p");
		empty.className = "db-inspector__empty";
		empty.textContent = t("brainstorm.database.collections.empty");
		section.appendChild(empty);
	} else {
		const ul = document.createElement("ul");
		ul.className = "db-inspector__collections-list";
		for (const { list, kind } of memberships) {
			ul.appendChild(buildMembershipRow(bindings, list, kind, badgeLabels));
		}
		section.appendChild(ul);
	}

	section.appendChild(buildAddToCollectionButton(bindings));
	return section;
}

function buildMembershipRow(
	bindings: InspectorCollectionsBindings,
	list: List,
	kind: MembershipKind,
	badgeLabels: Record<MembershipKind, string>,
): HTMLElement {
	const li = document.createElement("li");
	li.className = "db-inspector__collection-row";
	li.dataset.listId = list.id;
	li.dataset.kind = kind;

	const open = document.createElement("button");
	open.type = "button";
	open.className = "db-inspector__collection-open";
	const listIcon = bindings.createListIcon(list, 16);
	if (listIcon) open.appendChild(listIcon);
	const name = document.createElement("span");
	name.className = "db-inspector__collection-name";
	name.textContent = list.name;
	open.appendChild(name);
	open.title = `Open "${list.name}"`;
	open.setAttribute("aria-label", `Open collection ${list.name}`);
	open.addEventListener("click", () => bindings.onSelectList(list.id));
	li.appendChild(open);

	const badge = document.createElement("span");
	badge.className = "db-inspector__collection-badge";
	badge.dataset.kind = kind;
	badge.textContent = badgeLabels[kind];
	li.appendChild(badge);

	// Vault-derived lists are read-only — the membership IS the type. No
	// remove button; users edit the entity's `type` to change that.
	if (!bindings.isVaultDerivedListId(list.id)) {
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "db-inspector__collection-remove";
		remove.appendChild(bindings.createCloseIcon(12));
		if (kind === MembershipKind.Excluded) {
			// Already excluded — the inverse op is "Add back" (un-exclude).
			remove.dataset.bsTooltip = `Add back to "${list.name}"`;
			remove.setAttribute("aria-label", `Add back to ${list.name}`);
			remove.dataset.action = "add-back";
			remove.addEventListener("click", () => bindings.onToggleEntityInList(list.id, true));
		} else {
			remove.dataset.bsTooltip = `Remove from "${list.name}"`;
			remove.setAttribute("aria-label", `Remove from ${list.name}`);
			remove.dataset.action = "remove";
			remove.addEventListener("click", () => bindings.onToggleEntityInList(list.id, false));
		}
		li.appendChild(remove);
	}

	return li;
}

function buildAddToCollectionButton(bindings: InspectorCollectionsBindings): HTMLElement {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "db-inspector__add-to-collection";
	btn.dataset.testid = INSPECTOR_ADD_TO_COLLECTION_TESTID;
	btn.appendChild(bindings.createPlusIcon(14));
	const label = document.createElement("span");
	label.textContent = t("brainstorm.database.collections.add");
	btn.appendChild(label);
	// Disable the button when there are no candidates to add — the picker
	// would otherwise pop up only to immediately flash an empty-state.
	const candidates = pickerCandidatesForEntity(
		bindings.entityId,
		bindings.lists,
		bindings.db,
		bindings.isVaultDerivedListId,
	);
	if (candidates.length === 0) {
		btn.disabled = true;
		btn.title = t("brainstorm.database.collections.allIncluded");
	}
	btn.addEventListener("click", () => {
		if (btn.disabled) return;
		const r = btn.getBoundingClientRect();
		bindings.onAddRequest({ x: r.left, y: r.bottom + 4 });
	});
	return btn;
}

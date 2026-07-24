/**
 * Row context-menu composition (F-216/F-217) — which app-owned items the
 * shared object menu gets for a row, as pure decisions so the gating is
 * unit-testable without booting the imperative app:
 *
 *   - **Rename** opens the grid title cell's inline editor, so it's offered
 *     exactly where that editor exists: a generic `brainstorm/Object/v1`
 *     row (typed rows rename in their own app) on a Grid view.
 *   - **Hide / Remove from list** only on a user list (vault-derived
 *     type-lists ARE their type — membership is read-only).
 *   - **Delete** (the destructive `onRemove` slot) is always offered — the
 *     vault-wide destroy that "Remove from list" was mistaken for (F-217).
 */

import { GENERIC_OBJECT_TYPE } from "@brainstorm-os/sdk-types";
import { ListViewKind } from "../types/list-view";

export type RowMenuPlan = {
	offerRename: boolean;
	offerMembershipToggle: boolean;
	offerDelete: boolean;
};

export function rowMenuPlan(input: {
	entityType: string;
	viewKind: ListViewKind | undefined;
	listId: string | undefined;
	isVaultDerived: (id: string) => boolean;
}): RowMenuPlan {
	return {
		offerRename: input.entityType === GENERIC_OBJECT_TYPE && input.viewKind === ListViewKind.Grid,
		offerMembershipToggle: input.listId !== undefined && !input.isVaultDerived(input.listId),
		offerDelete: true,
	};
}

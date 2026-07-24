import { GENERIC_OBJECT_TYPE } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { ListViewKind } from "../types/list-view";
import { rowMenuPlan } from "./row-menu";

const isVaultDerived = (id: string): boolean => id.startsWith("list_vault_");

describe("rowMenuPlan (F-216/F-217)", () => {
	it("offers Rename for a generic Object row on a Grid view", () => {
		const plan = rowMenuPlan({
			entityType: GENERIC_OBJECT_TYPE,
			viewKind: ListViewKind.Grid,
			listId: "list_user_crm",
			isVaultDerived,
		});
		expect(plan.offerRename).toBe(true);
	});

	it("no Rename for typed rows (they rename in their own app)", () => {
		const plan = rowMenuPlan({
			entityType: "brainstorm/Task/v1",
			viewKind: ListViewKind.Grid,
			listId: "list_user_crm",
			isVaultDerived,
		});
		expect(plan.offerRename).toBe(false);
	});

	it("no Rename outside the Grid view (the inline editor lives in the title cell)", () => {
		for (const kind of [
			ListViewKind.List,
			ListViewKind.Gallery,
			ListViewKind.Board,
			ListViewKind.Calendar,
			ListViewKind.Timeline,
			undefined,
		]) {
			const plan = rowMenuPlan({
				entityType: GENERIC_OBJECT_TYPE,
				viewKind: kind,
				listId: "list_user_crm",
				isVaultDerived,
			});
			expect(plan.offerRename, String(kind)).toBe(false);
		}
	});

	it("membership toggle only on user lists, never on vault-derived type-lists", () => {
		const onUser = rowMenuPlan({
			entityType: GENERIC_OBJECT_TYPE,
			viewKind: ListViewKind.Grid,
			listId: "list_user_crm",
			isVaultDerived,
		});
		expect(onUser.offerMembershipToggle).toBe(true);
		const onDerived = rowMenuPlan({
			entityType: GENERIC_OBJECT_TYPE,
			viewKind: ListViewKind.Grid,
			listId: "list_vault_task",
			isVaultDerived,
		});
		expect(onDerived.offerMembershipToggle).toBe(false);
		const noList = rowMenuPlan({
			entityType: GENERIC_OBJECT_TYPE,
			viewKind: ListViewKind.Grid,
			listId: undefined,
			isVaultDerived,
		});
		expect(noList.offerMembershipToggle).toBe(false);
	});

	it("Delete is always offered — Remove-from-list must not be the only exit (F-217)", () => {
		for (const entityType of [GENERIC_OBJECT_TYPE, "brainstorm/Task/v1"]) {
			for (const listId of ["list_user_crm", "list_vault_task", undefined]) {
				const plan = rowMenuPlan({
					entityType,
					viewKind: ListViewKind.Grid,
					listId,
					isVaultDerived,
				});
				expect(plan.offerDelete).toBe(true);
			}
		}
	});
});

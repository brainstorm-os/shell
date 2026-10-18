/**
 * "New" inside an embedded Database block (9.12.24 follow-up). The new row
 * is drafted exactly like the app's "+ New" — the List's source + the view's
 * AND-pinned filters — with the host document as `$host`, so a contextual
 * view ("author is this page") pre-fills the relation to the page the block
 * sits in. A manual collection (no type source) also pins the new row into
 * its members so it shows up.
 */

import { type ListView, type MemberOverrides, decideRowCreate } from "@brainstorm-os/sdk-types";
import { draftForList } from "../../logic/entity-draft";
import { addToList } from "../../logic/members";
import { type BlockGraph, type BpEntity, readSource } from "./resolve-rows";

export type EmbeddedRowPlan = {
	entityTypeId: string;
	properties: Record<string, unknown>;
	addToMembers: boolean;
};

export function planEmbeddedRow(
	list: BpEntity,
	view: ListView | null,
	hostEntityId: string | null,
): EmbeddedRowPlan {
	const source = readSource(list);
	const draft = draftForList({
		source,
		viewFilters: view?.filters ?? null,
		defaultTypeUrl: view?.defaultTypeUrl ?? null,
		...(hostEntityId ? { hostEntityId } : {}),
	});
	const plan = decideRowCreate({ source });
	return {
		entityTypeId: draft.type ?? plan.type,
		properties: draft.properties,
		addToMembers: plan.addToMembers,
	};
}

function readMembers(list: BpEntity): MemberOverrides {
	const raw = list.properties.members as Partial<MemberOverrides> | undefined;
	return {
		include: Array.isArray(raw?.include) ? raw.include : [],
		exclude: Array.isArray(raw?.exclude) ? raw.exclude : [],
	};
}

/** Create the row through the BP graph (capability-gated host-side) and, for
 *  a manual collection, pin it into the List's members. Returns the new
 *  entity. */
export async function createEmbeddedRow(
	graph: BlockGraph,
	list: BpEntity,
	view: ListView | null,
	hostEntityId: string | null,
): Promise<BpEntity> {
	const plan = planEmbeddedRow(list, view, hostEntityId);
	const created = await graph<BpEntity>("createEntity", {
		entityTypeId: plan.entityTypeId,
		properties: plan.properties,
	});
	if (plan.addToMembers) {
		const members = addToList(readMembers(list), created.entityId, {
			matchesSource: false,
			by: "user",
		}).members;
		await graph("updateEntity", {
			entityId: list.entityId,
			entityTypeId: list.entityTypeId,
			properties: { members },
		});
	}
	return created;
}

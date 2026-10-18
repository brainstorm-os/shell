/**
 * Quick-capture filing (9.16.14) — turns a routed capture into writes.
 *
 * Collections come from the vault snapshot through the SDK List codec
 * (`entityToList`), and what a new member IS comes from the shared
 * `decideRowCreate` contract (a typed list mints its type; a manual / custom
 * collection mints a generic `brainstorm/Object/v1` pinned into its manual
 * members) — the same decision Database's "+ New" and the Agent's row
 * proposals make. Journal only offers a collection it can actually write a
 * member of: the type must be one it holds `entities.write` for, so a tag
 * naming, say, a Tasks list stays a plain line instead of failing a write.
 *
 * Membership rides the SDK's `toggleCollectionMembership` (re-reads the List,
 * minimal manual-include write). The day keeps a line that MENTIONS the new
 * object, so the shell's link extraction ties the two together both ways —
 * the object's backlinks show the day it was captured on.
 */

import { LIST_ENTITY_TYPE, entityToList } from "@brainstorm-os/sdk";
import { decideRowCreate } from "@brainstorm-os/sdk-types";
import {
	type CollectionMembershipService,
	toggleCollectionMembership,
} from "@brainstorm-os/sdk/object-menu";
import {
	type CaptureCollection,
	CaptureKind,
	type CaptureRoute,
	routeCapture,
} from "./quick-capture";

export enum CapturePartKind {
	Text = "text",
	Mention = "mention",
}

export type CaptureLinePart =
	| { kind: CapturePartKind.Text; text: string }
	| { kind: CapturePartKind.Mention; entityId: string; entityType: string; label: string };

export enum CaptureOutcome {
	/** Nothing to capture (blank input). */
	Ignored = "ignored",
	/** No editor to append into — nothing was written. */
	Unavailable = "unavailable",
	/** Appended as a plain line. */
	Appended = "appended",
	/** Filed into the collection and linked from the day. */
	Filed = "filed",
	/** The object was created and linked, but joining the collection failed. */
	FiledWithoutMembership = "filed-without-membership",
	/** Creating the object failed; the line was kept as a plain line. */
	FileFailed = "file-failed",
}

/** A collection Journal can file into, with the type a new member gets. */
export type FileableCollection = CaptureCollection & { memberType: string; pinMember: boolean };

type SnapshotRow = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
};

function canWrite(capabilities: readonly string[], type: string): boolean {
	return (
		capabilities.includes(`entities.write:${type}`) || capabilities.includes("entities.write:*")
	);
}

/** The user's collections Journal can file a capture into, A→Z. */
export function fileableCollections(
	rows: readonly SnapshotRow[],
	capabilities: readonly string[],
): FileableCollection[] {
	if (!canWrite(capabilities, LIST_ENTITY_TYPE)) return [];
	const out: FileableCollection[] = [];
	for (const row of rows) {
		if (row.type !== LIST_ENTITY_TYPE || row.deletedAt !== null) continue;
		const list = entityToList(row);
		if (!list || list.name.trim() === "") continue;
		const plan = decideRowCreate(list);
		if (!canWrite(capabilities, plan.type)) continue;
		out.push({ id: list.id, name: list.name, memberType: plan.type, pinMember: plan.addToMembers });
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

export type CaptureWriter = {
	create(type: string, properties: Record<string, unknown>): Promise<{ id: string }>;
	membership: CollectionMembershipService | null;
	appId: string;
	now: number;
};

export type CommitCaptureInput = {
	raw: string;
	collections: readonly FileableCollection[];
	writer: CaptureWriter | null;
	canAppend: () => boolean;
	append: (parts: readonly CaptureLinePart[]) => boolean;
};

export type CommitCaptureResult = { outcome: CaptureOutcome; route: CaptureRoute };

function plainLine(text: string): CaptureLinePart[] {
	return [{ kind: CapturePartKind.Text, text }];
}

export async function commitCapture(input: CommitCaptureInput): Promise<CommitCaptureResult> {
	const route = routeCapture(input.raw, input.collections);
	if (route.kind === CaptureKind.Empty) return { outcome: CaptureOutcome.Ignored, route };
	if (!input.canAppend()) return { outcome: CaptureOutcome.Unavailable, route };
	if (route.kind === CaptureKind.Line) {
		return {
			outcome: input.append(plainLine(route.text))
				? CaptureOutcome.Appended
				: CaptureOutcome.Unavailable,
			route,
		};
	}

	const collection = input.collections.find((c) => c.id === route.collection.id);
	const writer = input.writer;
	if (!collection || !writer) {
		input.append(plainLine(route.text));
		return { outcome: CaptureOutcome.FileFailed, route };
	}

	let created: { id: string };
	try {
		created = await writer.create(collection.memberType, {
			name: route.title,
			createdAt: writer.now,
			updatedAt: writer.now,
		});
	} catch (error) {
		console.warn("[journal] quick-capture create failed:", error);
		input.append(plainLine(route.text));
		return { outcome: CaptureOutcome.FileFailed, route };
	}

	input.append([
		{
			kind: CapturePartKind.Mention,
			entityId: created.id,
			entityType: collection.memberType,
			label: route.title,
		},
		{ kind: CapturePartKind.Text, text: ` #${route.tag}` },
	]);

	if (!collection.pinMember) return { outcome: CaptureOutcome.Filed, route };
	if (!writer.membership) return { outcome: CaptureOutcome.FiledWithoutMembership, route };
	try {
		const joined = await toggleCollectionMembership(
			writer.membership,
			collection.id,
			created.id,
			true,
			writer.appId,
		);
		return { outcome: joined ? CaptureOutcome.Filed : CaptureOutcome.FiledWithoutMembership, route };
	} catch (error) {
		console.warn("[journal] quick-capture membership failed:", error);
		return { outcome: CaptureOutcome.FiledWithoutMembership, route };
	}
}

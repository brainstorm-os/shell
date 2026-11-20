/**
 * THE CONTAINER RULE (0.16.0, design 71 §Authorization).
 *
 * A channel's message is its own entity with its own access record, and its
 * author is that record's root owner - which no revoke can undo. So "removed
 * from the channel" cannot be enforced on the message's record alone. A shared
 * child is therefore written, and re-keyed, only by a current Editor+ of every
 * container that GOVERNS it, in addition to their standing on the child.
 *
 * What governs a child, all from this device's own knowledge - never from the
 * update being judged:
 *
 *   - the container it was first seen in (`entity_containers`: pinned by the
 *     sharing engine when it cascades the child, by the share-bootstrap gate
 *     when it admits one, else from the `via` of the child's effective grants,
 *     else - a child older than both - from the row's parent property the
 *     first time it is asked); and
 *   - the container this device's row for it points at NOW, when that is a
 *     shared container here. A child that has been moved answers to both: the
 *     move does not release it from the first, and the member who is not in
 *     the second cannot write what is shown there.
 *
 * A re-parent is itself checked: an update that changes a child's parent
 * property is applied only if its sender stands in the destination too.
 */

import type * as Y from "yjs";
import { readEntityDocProjection } from "../entities/entity-doc-codec";
import type { VaultSession } from "../vault/session";
import { type AccessTrust, hasAccessEntries, isAuthorizedWriter } from "./access-record";
import type { AccessTrustStore } from "./access-trust";
import { containmentRuleForChild } from "./containment-registry";

export type ContainerRuleDeps = {
	session: VaultSession;
	accessTrust: AccessTrustStore;
	/** This device's row for an entity: its type and its stored properties. */
	rowOf: (entityId: string) => { type: string; properties: Record<string, unknown> } | null;
};

/** Is `containerId` a SHARED container on this device - one with an access
 *  record, or one that has had a root pinned? A child of a purely local
 *  container answers to nobody but its own record. */
async function isSharedContainerHere(
	deps: ContainerRuleDeps,
	containerId: string,
): Promise<boolean> {
	if (deps.accessTrust.rootOf(containerId) !== null) return true;
	const { doc } = await deps.session.ydocStore.load(containerId);
	try {
		return hasAccessEntries(doc);
	} finally {
		doc.destroy();
	}
}

/** The shared container this device's row for `entityId` points at, or null. */
async function structuralContainer(
	deps: ContainerRuleDeps,
	entityId: string,
): Promise<string | null> {
	const row = deps.rowOf(entityId);
	const rule = row ? containmentRuleForChild(row.type) : null;
	const parent = rule ? row?.properties[rule.childParentProp] : undefined;
	if (typeof parent !== "string" || parent === "") return null;
	return (await isSharedContainerHere(deps, parent)) ? parent : null;
}

/** Every container whose membership governs `entityId` on this device. Empty
 *  for an entity that is not a child of a shared container. */
export async function governingContainers(
	deps: ContainerRuleDeps,
	doc: Y.Doc,
	entityId: string,
	trust: AccessTrust,
): Promise<string[]> {
	const structural = await structuralContainer(deps, entityId);
	const governing = new Set(deps.accessTrust.containersOf(doc, entityId, trust, structural));
	if (structural !== null) governing.add(structural);
	return [...governing].sort();
}

/** Is `senderKey` a current Editor+ of every one of `containers`? */
export async function admittedByContainers(
	deps: ContainerRuleDeps,
	containers: readonly string[],
	senderKey: Uint8Array,
): Promise<boolean> {
	for (const containerId of containers) {
		const { doc } = await deps.session.ydocStore.load(containerId);
		try {
			const trust = deps.accessTrust.trustFor(doc, containerId);
			if (!isAuthorizedWriter(doc, containerId, senderKey, trust)) return false;
		} finally {
			doc.destroy();
		}
	}
	return true;
}

/** The parent property `doc` carries for a child of type `type`, or undefined
 *  when the type is not a child type or the doc names no parent. */
export function parentNamedBy(type: string | undefined, doc: Y.Doc): string | undefined {
	const rule = type ? containmentRuleForChild(type) : null;
	if (!rule) return undefined;
	const parent = readEntityDocProjection(doc).properties?.[rule.childParentProp];
	return typeof parent === "string" && parent !== "" ? parent : undefined;
}

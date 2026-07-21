/**
 * Backlinks — every other vault entity whose body references the
 * current note (via an `@`-mention or a `brainstorm://entity/<id>`
 * link). Pure over a snapshot so it unit-tests without a vault; the
 * reference set is exactly what `extractReferences` recognises (the
 * same set the shell-side walker emits Graph edges from), so backlinks
 * and Graph edges never disagree.
 */

import type { VaultEntity } from "@brainstorm-os/sdk-types";
import type { SerializedEditorState } from "lexical";
import { entityTitleOf } from "../store/entity-title-index";
import { extractReferences } from "./extract-references";

export type Backlink = { id: string; type: string; title: string };

export function computeBacklinks(entities: readonly VaultEntity[], currentId: string): Backlink[] {
	if (!currentId) return [];
	const out: Backlink[] = [];
	for (const entity of entities) {
		if (entity.id === currentId) continue;
		const body = (entity.properties as { body?: unknown }).body as
			| SerializedEditorState
			| string
			| null
			| undefined;
		const refs = extractReferences(body);
		if (refs.some((r) => r.entityId === currentId)) {
			out.push({
				id: entity.id,
				type: (entity as { type?: string }).type ?? "",
				title: entityTitleOf(entity),
			});
		}
	}
	return out;
}

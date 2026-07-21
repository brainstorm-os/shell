/**
 * Welcome-2 template import (9.3.5.V 7d) — merge a parsed `TemplateManifest`
 * into the current vault. Mirrors `seedWelcomeContent`: idempotent (a per-vault
 * stamp keyed by the template id, so a re-import is a no-op), per-entity error
 * isolation, dependency-injected so the create+plant+stamp logic is testable
 * in-process without a live session (the real binding mints the repo create /
 * ydoc plant / stamp store, as `runWelcomeSeed` does).
 *
 * The difference from the welcome seed: every imported entity is also made a
 * member of a parent **`brainstorm/List/v1` Collection** (built through the 7a
 * `listToEntityProperties` codec) named for the template — so the user can see
 * the whole template as one Collection and remove it cleanly via Bin (delete
 * the Collection + its members), per [28 §Vault portability]. Merge-not-
 * replace by construction: it only ever creates rows in the manifest's id
 * namespace.
 */

import { LIST_ENTITY_TYPE, listToEntityProperties } from "@brainstorm-os/sdk";
import type { List, MemberInclude } from "@brainstorm-os/sdk-types";
import type { TemplateManifest } from "./template-codec";
import type { WelcomeBody } from "./welcome-content";
import type { WelcomeSeedEntitySpec } from "./welcome-seed";

/** Sentinel `created_by` on template-imported entities (provenance; not a real
 *  app id). */
export const TEMPLATE_CREATED_BY = "io.brainstorm.welcome/template";

const TEMPLATE_IMPORT_VERSION = 1;

/** Stable parent-Collection id for a template — derived from the template id so
 *  a re-import resolves the same Collection and the user can find/remove the
 *  whole template by it. */
export function templateCollectionId(templateId: string): string {
	return `template-collection-${templateId}`;
}

export enum TemplateImportOutcome {
	Imported = "imported",
	/** The vault's stamp already covers this template; nothing done. */
	AlreadyImported = "already-imported",
}

export type TemplateImportResult = {
	readonly outcome: TemplateImportOutcome;
	readonly created: number;
	readonly planted: number;
	readonly collectionId: string | null;
	readonly errors: ReadonlyArray<string>;
};

export type TemplateImportDeps = {
	readonly createEntity: (spec: WelcomeSeedEntitySpec) => void | Promise<void>;
	readonly plantBody: (entityId: string, body: WelcomeBody) => void | Promise<void>;
	/** The vault's last-imported version for THIS template (`0` = never). */
	readonly readVersion: () => number | Promise<number>;
	readonly writeVersion: (version: number) => void | Promise<void>;
	readonly now: number;
};

function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function importTemplate(
	manifest: TemplateManifest,
	deps: TemplateImportDeps,
): Promise<TemplateImportResult> {
	const current = await deps.readVersion();
	if (current >= TEMPLATE_IMPORT_VERSION) {
		return {
			outcome: TemplateImportOutcome.AlreadyImported,
			created: 0,
			planted: 0,
			collectionId: null,
			errors: [],
		};
	}

	const errors: string[] = [];
	let created = 0;
	let planted = 0;

	for (const entity of manifest.entities) {
		try {
			await deps.createEntity({
				id: entity.id,
				type: entity.type,
				properties: entity.properties,
				createdBy: TEMPLATE_CREATED_BY,
				now: deps.now,
			});
			created += 1;
			if (entity.body) {
				await deps.plantBody(entity.id, entity.body);
				planted += 1;
			}
		} catch (error) {
			errors.push(`${entity.id}: ${errMsg(error)}`);
		}
	}

	// The parent Collection: a manual `List/v1` whose include-members are every
	// imported entity (so the template is one removable unit).
	const collectionId = templateCollectionId(manifest.id);
	try {
		const include: MemberInclude[] = manifest.entities.map((e) => ({
			entityId: e.id,
			addedAt: deps.now,
			by: "user",
		}));
		const collection: List = {
			id: collectionId,
			name: manifest.name,
			icon: null,
			description: manifest.description,
			source: null,
			members: { include, exclude: [] },
			views: [],
			defaultViewId: null,
			defaultTemplate: null,
			createdAt: deps.now,
			updatedAt: deps.now,
		};
		await deps.createEntity({
			id: collectionId,
			type: LIST_ENTITY_TYPE,
			properties: listToEntityProperties(collection),
			createdBy: TEMPLATE_CREATED_BY,
			now: deps.now,
		});
		created += 1;
	} catch (error) {
		errors.push(`collection: ${errMsg(error)}`);
	}

	// Stamp after the run (even on partial failure) so a stable id is never
	// re-minted on the next attempt.
	try {
		await deps.writeVersion(TEMPLATE_IMPORT_VERSION);
	} catch (error) {
		errors.push(`stamp: ${errMsg(error)}`);
	}

	return {
		outcome: TemplateImportOutcome.Imported,
		created,
		planted,
		collectionId,
		errors,
	};
}

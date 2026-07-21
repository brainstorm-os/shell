/**
 * Shared in-process create+plant deps for the privileged seeders (Welcome-1
 * starter content + Welcome-2 template import). Both run the identical
 * mechanics — a `repo.create` with `dekId: null` (the shell-internal path the
 * same vault-open pass retro-wraps via `runRetroWrapNullDeks`; the ydoc store
 * is crypto-free at 10.1) + a body planted into the entity's universal-body
 * Y.Doc through the ydoc worker — so the loop lives here once.
 *
 * Dependency-injected `applyDocUpdate` keeps it testable in-process (the
 * pipeline tests wire the worker's `handleYDocEnvelope` directly; production
 * wires the real ydoc-worker `applyUpdate`).
 */

import {
	BASELINE_NODES,
	SEED_STANDIN_NODES,
	plantSerializedStateIntoDoc,
} from "@brainstorm-os/editor";
import { Doc, encodeStateAsUpdate } from "yjs";
import { bytesToBase64 } from "../credentials/crypto";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import type { VaultSession } from "../vault/session";
import type { WelcomeBody } from "./welcome-content";
import type { WelcomeSeedEntitySpec } from "./welcome-seed";

/** Every node type a bundled body may reference (baseline blocks + the
 *  extracted seed stand-ins for title / mention / rule). */
const PLANT_NODES = [...BASELINE_NODES, ...SEED_STANDIN_NODES];

/** Persist a plaintext Yjs update into an entity's universal-body doc. The
 *  caller wires this to the ydoc worker (`applyUpdate`); the in-process
 *  pipeline test wires the worker's `handleYDocEnvelope` directly. */
export type ApplyDocUpdate = (entityId: string, updateB64: string) => Promise<void>;

/** The `createEntity` + `plantBody` half of a `seedWelcomeContent` /
 *  `importTemplate` dep bag — the part that touches the live vault. */
export type SeedEntityDeps = {
	createEntity: (spec: WelcomeSeedEntitySpec) => void;
	plantBody: (entityId: string, body: WelcomeBody) => Promise<void>;
};

/** Build the privileged create+plant deps from a live session. `createEntity`
 *  is idempotent (skips an id that already exists, so a prior partial run /
 *  stamp-write failure can't double-INSERT). */
export async function makeSeedEntityDeps(
	session: Pick<VaultSession, "vaultPath" | "dataStores">,
	applyDocUpdate: ApplyDocUpdate,
): Promise<SeedEntityDeps> {
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	return {
		createEntity: (spec) => {
			if (repo.get(spec.id)) return;
			repo.create({
				id: spec.id,
				type: spec.type,
				properties: spec.properties,
				createdBy: spec.createdBy,
				now: spec.now,
				dekId: null,
			});
		},
		plantBody: async (entityId, body) => {
			const doc = new Doc();
			try {
				plantSerializedStateIntoDoc(doc, body as never, {
					nodes: PLANT_NODES,
					namespace: `bs-seed-${entityId}`,
				});
				await applyDocUpdate(entityId, bytesToBase64(encodeStateAsUpdate(doc)));
			} finally {
				doc.destroy();
			}
		},
	};
}

/**
 * Editor entity-index + open-host wiring for the day-body `@`-mention /
 * transclusion typeaheads.
 *
 * The shared `@brainstorm/editor` index wants a `{ list, onChange }` source.
 * Rather than open a SECOND raw `vaultEntities.onChange` subscription (the app
 * already reads the live snapshot through `useVaultEntities`), we feed the
 * editor index from that SAME reactive snapshot: `app.tsx` calls
 * `pushEntityIndex(entities)` whenever its `useVaultEntities` result changes,
 * and this module fans the change out to the editor's index listener. One
 * subscription, no hand-rolled change loop.
 *
 * Degrades to no-ops on standalone / preview (no intents service; the index
 * simply lists whatever snapshot was last pushed).
 */

import { setEditorHost, setEntityIndexSource } from "@brainstorm/editor";
import { openEntity } from "@brainstorm/sdk";
import type { Intent, VaultEntity } from "@brainstorm/sdk-types";
import { getJournalRuntime } from "../runtime";

let current: readonly VaultEntity[] = [];
const listeners = new Set<() => void>();
let installed = false;

/** Install the index source + open host once. Idempotent. */
export function wireEditorIndex(): void {
	if (!installed) {
		installed = true;
		setEntityIndexSource({
			list: async () => ({ entities: current }),
			onChange: (listener) => {
				listeners.add(listener);
				return { unsubscribe: () => listeners.delete(listener) };
			},
		});
	}
	const intentsSvc = getJournalRuntime()?.services?.intents;
	const storageSvc = getJournalRuntime()?.services?.storage;
	const blocksSvc = getJournalRuntime()?.services?.blocks;
	const bpSvc = getJournalRuntime()?.services?.bp;
	setEditorHost({
		...(intentsSvc
			? {
					openEntity: (target) => {
						const openCapable = {
							services: {
								intents: {
									dispatch: (intent: { verb: string; payload: Record<string, unknown> }) =>
										intentsSvc.dispatch(intent as Omit<Intent, "source">),
								},
							},
						};
						void openEntity(openCapable, target);
					},
				}
			: {}),
		...(storageSvc
			? { uploadFile: (filename, bytes, mime) => storageSvc.uploadFile(filename, bytes, mime) }
			: {}),
		// The shared `/embed` entity card resolves + mounts live blocks through
		// these ("blocks.read" is a default-minimum grant; `bp.dispatch` is
		// uncapped structural routing). Absent in preview → chrome card only.
		...(blocksSvc
			? {
					blocks: {
						forType: (entityType: string) => blocksSvc.forType(entityType),
						source: (blockId: string) => blocksSvc.source(blockId),
					},
				}
			: {}),
		...(bpSvc ? { bp: bpSvc } : {}),
	});
}

/** Feed the editor index the latest live snapshot (called from `app.tsx` as
 *  its `useVaultEntities` result changes). */
export function pushEntityIndex(entities: readonly VaultEntity[]): void {
	current = entities;
	for (const listener of [...listeners]) listener();
}

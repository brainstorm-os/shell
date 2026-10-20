/**
 * Builds the per-vault-session `VersionHistory` (10.16) over the session's
 * `entities.db` and the ydoc worker. Rebuilt on every session activation.
 */

import { join } from "node:path";
import { AccessRole, resolveMembers, roleOf } from "../collab/access-record";
import {
	EntitiesRepository,
	EntityVersionsRepository,
	HistoryChangeSetsRepository,
} from "../storage/entities-repo";
import type { VaultSession } from "../vault/session";
import { HistoryRole } from "./history-service";
import { type RetentionPolicy, defaultRetentionPolicy } from "./retention-policy";
import { measureVaultBytes } from "./vault-size";
import type { EntityRestorer } from "./version-history";
import { type HistoryCaptureReply, RETENTION_INTERVAL_MS, VersionHistory } from "./version-history";

/** The active-session seams `bindSessionHistory` needs (injectable in tests). */
export type SessionHistoryHooks = {
	follow: (listener: (session: VaultSession | null) => void) => () => void;
	onReleasing: (hook: (session: VaultSession) => Promise<void>) => () => void;
};

/**
 * Keep one `VersionHistory` per active session. `follow` must replay the
 * session already active at subscribe time: the default vault is restored at
 * boot BEFORE this is wired, and a plain change-listener would leave history
 * off until the user switched vaults. Pending writes are captured while the
 * outgoing session is still open (release drain), not dropped on dispose.
 */
export function bindSessionHistory(
	hooks: SessionHistoryHooks,
	build: (session: VaultSession) => VersionHistory,
): { current: () => VersionHistory | null; dispose: () => void } {
	let history: VersionHistory | null = null;
	const offFollow = hooks.follow((session) => {
		history?.dispose();
		history = session ? build(session) : null;
	});
	const offRelease = hooks.onReleasing(async () => {
		await history?.flush();
	});
	return {
		current: () => history,
		dispose: () => {
			offFollow();
			offRelease();
			history?.dispose();
			history = null;
		},
	};
}

export type YDocWorkerCall = (method: string, args: Record<string, unknown>) => Promise<unknown>;

export function createSessionHistory(input: {
	session: VaultSession;
	callWorker: YDocWorkerCall;
	getRestorer: () => EntityRestorer | null;
}): VersionHistory {
	const { session, callWorker } = input;
	const vaultPath = session.vaultPath;
	let cachedPolicy: { at: number; policy: RetentionPolicy } | null = null;
	return new VersionHistory({
		getStores: async () => {
			const db = await session.dataStores.open("entities");
			return {
				entities: new EntitiesRepository(db),
				versions: new EntityVersionsRepository(db),
				changeSets: new HistoryChangeSetsRepository(db),
			};
		},
		getRestorer: input.getRestorer,
		getPolicy: async () => {
			const now = Date.now();
			if (!cachedPolicy || now - cachedPolicy.at > RETENTION_INTERVAL_MS) {
				const bytes = await measureVaultBytes(vaultPath, [join(vaultPath, "data", "history")]);
				cachedPolicy = { at: now, policy: defaultRetentionPolicy(bytes) };
			}
			return cachedPolicy.policy;
		},
		worker: {
			capture: async (entityId, sinceStateKey) =>
				(await callWorker("historyCapture", {
					vaultPath,
					entityId,
					sinceStateKey,
				})) as HistoryCaptureReply,
			preview: async (entityId, frame) =>
				(await callWorker("historyPreview", { vaultPath, entityId, ...frame })) as {
					bodyText: string;
					properties: Record<string, unknown> | null;
				},
			compact: async (entityId, keep) =>
				(
					(await callWorker("historyCompact", { vaultPath, entityId, keep: [...keep] })) as {
						moved: Array<[number, number]>;
					}
				).moved,
		},
	});
}

const ROLE: Readonly<Record<AccessRole, HistoryRole>> = {
	[AccessRole.Owner]: HistoryRole.Owner,
	[AccessRole.Editor]: HistoryRole.Editor,
	[AccessRole.Viewer]: HistoryRole.Viewer,
};

/** The local user's standing on `entityId` from its signed access record.
 *  ≤1 active member ⇒ not shared. A shared object we hold no active grant on
 *  resolves to Viewer (fail closed). */
export async function resolveLocalHistoryRole(
	session: VaultSession,
	entityId: string,
): Promise<HistoryRole> {
	const { doc } = await session.ydocStore.load(entityId);
	try {
		if (resolveMembers(doc, entityId).filter((m) => m.active).length <= 1) {
			return HistoryRole.NotShared;
		}
		const role = roleOf(doc, entityId, session.identity.publicKeyBase64);
		return role ? ROLE[role] : HistoryRole.Viewer;
	} finally {
		doc.destroy();
	}
}

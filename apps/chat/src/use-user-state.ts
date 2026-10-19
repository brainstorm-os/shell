/**
 * Chats-2/3 — the React seam over `logic/user-state.ts`: read watermarks +
 * display prefs that follow the user, with the device-local `storage.kv`
 * watermarks as the one-time migration source.
 *
 * Synced mode needs both `entities` (to write the row) and a resolved owner
 * pubkey (the row's key). Without a roster the app has no durable owner key,
 * so it stays on the legacy device-local store — the pre-Chats-2 behaviour.
 *
 * Writes are debounced: the active channel acks on every arrival, and one
 * entity write per incoming message would be pure sync churn.
 */

import type { EntitiesService, RosterService, StorageService } from "@brainstorm-os/sdk-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EntityLike } from "./logic/chat";
import {
	READ_WATERMARKS_KEY,
	type ReadWatermarks,
	loadWatermarks,
	saveWatermarks,
} from "./logic/unread";
import {
	type ChatPrefs,
	DEFAULT_PREFS,
	USER_STATE_TYPE,
	buildUserStateProperties,
	isOwnUserStateRow,
	maxMergeWatermarks,
	readUserState,
	userStateCandidates,
} from "./logic/user-state";

export const USER_STATE_WRITE_DEBOUNCE_MS = 500;
const LOCAL_PREFS_KEY = "chat:prefs";

type Store = Pick<StorageService, "get" | "put"> & { delete?: StorageService["delete"] };

export type ChatUserState = {
	/** False until the stored marks (and, when synced, the owner) are known —
	 *  acking before then would baseline away messages that arrived while away. */
	ready: boolean;
	watermarks: ReadWatermarks;
	prefs: ChatPrefs;
	raiseWatermarks(next: ReadWatermarks): void;
	setPrefs(patch: Partial<ChatPrefs>): void;
};

function samePrefs(a: ChatPrefs, b: ChatPrefs): boolean {
	return a.absoluteTimestamps === b.absoluteTimestamps;
}

export function useChatUserState(args: {
	entities: readonly EntityLike[];
	entitiesSvc: Pick<EntitiesService, "create" | "update"> | null;
	storage: Store | null;
	/** True when the host can resolve a durable owner (a roster exists). */
	canSync: boolean;
	/** The resolved sovereign pubkey, or "" while resolving. */
	ownerRef: string;
	/** Tells the local member's own rows from planted ones (see
	 *  `isOwnUserStateRow`). Required for synced mode. */
	roster: Pick<RosterService, "members"> | null;
}): ChatUserState {
	const { entities, entitiesSvc, storage, canSync, ownerRef, roster } = args;
	const synced = canSync && !!entitiesSvc && !!roster;

	// id → own? Unclassified candidates are held back (not merged, not written
	// to) until the access record answers; a lookup failure counts as foreign.
	const [ownership, setOwnership] = useState<ReadonlyMap<string, boolean>>(new Map());
	const candidateIds = useMemo(
		() => userStateCandidates(entities, synced ? ownerRef : "").map((e) => e.id),
		[entities, synced, ownerRef],
	);
	const createdIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (!roster) return;
		const unknown = candidateIds.filter((id) => !ownership.has(id) && id !== createdIdRef.current);
		if (unknown.length === 0) return;
		let live = true;
		void Promise.all(
			unknown.map((id) =>
				roster.members(id).then(
					(members) => [id, isOwnUserStateRow(members)] as const,
					() => [id, false] as const,
				),
			),
		).then((answers) => {
			if (!live) return;
			setOwnership((prev) => {
				const next = new Map(prev);
				for (const [id, own] of answers) next.set(id, own);
				return next;
			});
		});
		return () => {
			live = false;
		};
	}, [roster, candidateIds, ownership]);
	const isOwn = useCallback(
		(id: string) => id === createdIdRef.current || ownership.get(id) === true,
		[ownership],
	);
	const classified = candidateIds.every((id) => id === createdIdRef.current || ownership.has(id));

	const [legacy, setLegacy] = useState<ReadWatermarks | null>(null);
	const [localPrefsLoaded, setLocalPrefsLoaded] = useState<ChatPrefs | null>(null);
	useEffect(() => {
		if (!storage) {
			setLegacy({});
			return;
		}
		let live = true;
		loadWatermarks(storage)
			.then((marks) => {
				if (live) setLegacy(marks);
			})
			.catch(() => {
				if (live) setLegacy({});
			});
		if (!synced) {
			storage
				.get<Partial<ChatPrefs>>(LOCAL_PREFS_KEY)
				.then((raw) => {
					if (live && raw && typeof raw === "object") setLocalPrefsLoaded({ ...DEFAULT_PREFS, ...raw });
				})
				.catch(() => undefined);
		}
		return () => {
			live = false;
		};
	}, [storage, synced]);

	const remote = useMemo(
		() => readUserState(entities, synced ? ownerRef : "", isOwn),
		[entities, synced, ownerRef, isOwn],
	);

	const [raised, setRaised] = useState<ReadWatermarks>({});
	const [pendingPrefs, setPendingPrefs] = useState<ChatPrefs | null>(null);

	const watermarks = useMemo(
		() => maxMergeWatermarks(maxMergeWatermarks(remote.watermarks, legacy ?? {}), raised),
		[remote.watermarks, legacy, raised],
	);
	const prefs = pendingPrefs ?? (synced ? remote.prefs : (localPrefsLoaded ?? DEFAULT_PREFS));

	// A pending pref write settles once the synced row reflects it; from then
	// on another device's change to the same pref shows through again.
	useEffect(() => {
		if (synced && pendingPrefs && samePrefs(pendingPrefs, remote.prefs)) setPendingPrefs(null);
	}, [synced, pendingPrefs, remote.prefs]);

	const ready = legacy !== null && (!synced || (ownerRef !== "" && classified));

	const latest = useRef({ watermarks, prefs, remote, ownerRef, classified });
	latest.current = { watermarks, prefs, remote, ownerRef, classified };
	const creatingRef = useRef<Promise<void> | null>(null);
	const migratedRef = useRef(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const disposedRef = useRef(false);

	const flush = useCallback(async (): Promise<void> => {
		timerRef.current = null;
		const {
			watermarks: marks,
			prefs: p,
			remote: r,
			ownerRef: owner,
			classified: known,
		} = latest.current;
		if (!synced || !entitiesSvc || !owner) return;
		// An own row still being classified is not yet a write target; writing
		// now would mint a duplicate row instead of updating it.
		if (!known) {
			if (disposedRef.current) return;
			timerRef.current = setTimeout(() => void flush(), USER_STATE_WRITE_DEBOUNCE_MS);
			return;
		}
		const props = buildUserStateProperties({
			owner,
			watermarks: marks,
			prefs: p,
			updatedAt: new Date().toISOString(),
		});
		if (creatingRef.current) await creatingRef.current;
		const target = r.primaryId ?? createdIdRef.current;
		try {
			if (target) {
				await entitiesSvc.update(target, props);
			} else {
				const creating = entitiesSvc.create(USER_STATE_TYPE, props).then((row) => {
					createdIdRef.current = row.id;
				});
				creatingRef.current = creating;
				await creating;
				creatingRef.current = null;
			}
			if (!migratedRef.current && storage?.delete) {
				migratedRef.current = true;
				await storage.delete(READ_WATERMARKS_KEY);
			}
		} catch (err) {
			creatingRef.current = null;
			console.warn("[chat] failed to save read state:", err);
		}
	}, [synced, entitiesSvc, storage]);

	const schedule = useCallback(() => {
		if (timerRef.current !== null) return;
		timerRef.current = setTimeout(() => void flush(), USER_STATE_WRITE_DEBOUNCE_MS);
	}, [flush]);

	useEffect(
		() => () => {
			disposedRef.current = true;
			if (timerRef.current === null) return;
			clearTimeout(timerRef.current);
			void flush();
		},
		[flush],
	);

	const raiseWatermarks = useCallback(
		(next: ReadWatermarks) => {
			setRaised((prev) => maxMergeWatermarks(prev, next));
			if (synced) {
				schedule();
				return;
			}
			if (storage) {
				const merged = maxMergeWatermarks(latest.current.watermarks, next);
				void saveWatermarks(storage, merged).catch(() => undefined);
			}
		},
		[synced, schedule, storage],
	);

	const setPrefs = useCallback(
		(patch: Partial<ChatPrefs>) => {
			const next = { ...latest.current.prefs, ...patch };
			setPendingPrefs(next);
			latest.current = { ...latest.current, prefs: next };
			if (synced) {
				schedule();
				return;
			}
			setLocalPrefsLoaded(next);
			if (storage) void storage.put(LOCAL_PREFS_KEY, next).catch(() => undefined);
		},
		[synced, schedule, storage],
	);

	return { ready, watermarks, prefs, raiseWatermarks, setPrefs };
}

/**
 * VersionHistory — the main-process checkpoint engine (doc `version-history.md`).
 *
 * Owns WHEN a checkpoint is taken and WHO it is attributed to; the bytes are
 * written by the ydoc worker (`historyCapture`) into the entity's `.yhist` and
 * the metadata lands in `entity_versions` through the repo.
 *
 *  - `noteWrite` is called after every committed write with SERVER-DERIVED
 *    principals (never client-supplied). It arms the `Idle` capture: 2 min
 *    after the last write, at most once per 10 min per entity, and only if the
 *    doc state actually changed.
 *  - `beginChangeSet` + `checkpointBefore` are the multi-entity seam for
 *    `BeforeBulk` / `AgentRun` / `Import`: one checkpoint per entity per change
 *    set, taken before that operation's first write to it.
 *  - `restore` / `revertChangeSet` take `BeforeRestore` checkpoints first, then
 *    hand the write to the entities service (`EntityRestorer`), so a restore is
 *    a normal forward edit — capabilities, locks and inverse relations apply.
 *
 * Every capture, restore and retention pass runs on ONE queue: a `.yhist`
 * rewrite can never interleave with an append whose row is not written yet.
 */

import { HistoryPrincipalKind, VersionCause } from "@brainstorm-os/sdk-types";
import type {
	ChangeSetPrincipal,
	EntitiesRepository,
	EntityVersionRecord,
	EntityVersionsRepository,
	HistoryChangeSetsRepository,
	StoredPrincipal,
} from "../storage/entities-repo";
import { isSafeEntityId } from "../storage/entity-id";
import type { HistFrameRef } from "../storage/yhist-store";
import { type RetentionCandidate, type RetentionPolicy, planRetention } from "./retention-policy";

export const IDLE_CAPTURE_DELAY_MS = 2 * 60 * 1000;
export const IDLE_CAPTURE_MIN_INTERVAL_MS = 10 * 60 * 1000;
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Upper bound on entities one `checkpointBefore` call may touch. */
export const CHECKPOINT_BATCH_MAX = 5000;
/** Entities whose last Idle capture time is remembered in memory; beyond it
 *  the oldest are forgotten and re-read from the latest stored version. */
export const IDLE_MEMO_MAX = 10_000;

export type HistoryStores = {
	entities: EntitiesRepository;
	versions: EntityVersionsRepository;
	changeSets: HistoryChangeSetsRepository;
};

export type HistoryCaptureReply =
	| { captured: false; stateKey: string }
	| {
			captured: true;
			stateKey: string;
			offset: number;
			length: number;
			properties: Record<string, unknown> | null;
			encodeMs: number;
	  };

/** The ydoc-worker half of history. */
export type HistoryWorkerPort = {
	capture(entityId: string, sinceStateKey: string | null): Promise<HistoryCaptureReply>;
	preview(
		entityId: string,
		frame: HistFrameRef,
	): Promise<{ bodyText: string; properties: Record<string, unknown> | null }>;
	compact(entityId: string, keep: readonly HistFrameRef[]): Promise<Array<[number, number]>>;
};

/** Writes a checkpoint back as a forward edit, through the entities service
 *  (its capability + lock + inverse-relation rules). Throws `Denied` /
 *  `Invalid` exactly as `entities.update` would. */
export type EntityRestorer = (input: {
	app: string;
	entityId: string;
	properties: Record<string, unknown>;
	frame: HistFrameRef;
	/** The acting principal is an agent: its write is attributed to it. */
	agent: boolean;
}) => Promise<void>;

export enum RevertGateResult {
	Allow = "allow",
	Deny = "deny",
	Locked = "locked",
}

export enum RevertOutcome {
	Reverted = "reverted",
	EditedSince = "edited-since",
	Deleted = "deleted",
	Locked = "locked",
	Denied = "denied",
}

export type RevertEntityResult = { entityId: string; outcome: RevertOutcome };

export type VersionHistoryOptions = {
	getStores: () => Promise<HistoryStores | null>;
	worker: HistoryWorkerPort;
	getRestorer: () => EntityRestorer | null;
	getPolicy: () => Promise<RetentionPolicy>;
	now?: () => number;
	newId?: () => string;
	idleDelayMs?: number;
	idleMinIntervalMs?: number;
	retentionIntervalMs?: number;
	/** Perf gate — every real capture's encode time and size. */
	onCapture?: (info: {
		entityId: string;
		cause: VersionCause;
		encodeMs: number;
		bytes: number;
	}) => void;
};

const principalKey = (p: { kind: HistoryPrincipalKind; id: string }): string => `${p.kind}:${p.id}`;

function named(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

export class VersionHistory {
	private readonly now: () => number;
	private readonly newId: () => string;
	private readonly idleDelayMs: number;
	private readonly idleMinIntervalMs: number;
	private readonly retentionIntervalMs: number;
	private readonly pending = new Map<string, Map<string, StoredPrincipal>>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly lastIdleAt = new Map<string, number>();
	private lastRetentionAt = Number.NEGATIVE_INFINITY;
	private chain: Promise<unknown> = Promise.resolve();
	private disposed = false;

	constructor(private readonly options: VersionHistoryOptions) {
		this.now = options.now ?? (() => Date.now());
		this.newId =
			options.newId ??
			(() => `ver_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
		this.idleDelayMs = options.idleDelayMs ?? IDLE_CAPTURE_DELAY_MS;
		this.idleMinIntervalMs = options.idleMinIntervalMs ?? IDLE_CAPTURE_MIN_INTERVAL_MS;
		this.retentionIntervalMs = options.retentionIntervalMs ?? RETENTION_INTERVAL_MS;
	}

	/** Record that `principals` wrote to `entityId` just now, and arm `Idle`. */
	noteWrite(entityId: string, principals: readonly ChangeSetPrincipal[]): void {
		if (this.disposed || !isSafeEntityId(entityId) || principals.length === 0) return;
		const at = this.now();
		let writers = this.pending.get(entityId);
		if (!writers) {
			writers = new Map();
			this.pending.set(entityId, writers);
		}
		for (const p of principals) {
			writers.set(principalKey(p), { kind: p.kind, id: p.id, lastWriteAt: at });
		}
		this.arm(entityId, at + this.idleDelayMs);
	}

	/** Open a change set that `checkpointBefore` calls then attach to. */
	beginChangeSet(cause: VersionCause, principals: readonly ChangeSetPrincipal[]): Promise<string> {
		return this.run(async () =>
			this.beginChangeSetLocked(await this.requireStores(), cause, principals),
		);
	}

	/** Checkpoint each entity before the change set's first write to it.
	 *  Idempotent per (entity, change set). Returns the new version ids. */
	checkpointBefore(entityIds: readonly string[], changeSetId: string): Promise<string[]> {
		const unique = [...new Set(entityIds)].filter(isSafeEntityId);
		if (unique.length > CHECKPOINT_BATCH_MAX) {
			return Promise.reject(named("Invalid", `history: more than ${CHECKPOINT_BATCH_MAX} entities`));
		}
		return this.run(async () => {
			const stores = await this.requireStores();
			const cs = stores.changeSets.get(changeSetId);
			if (!cs) throw named("Invalid", `history: unknown change set ${changeSetId}`);
			const made: string[] = [];
			for (const id of unique) {
				if (stores.versions.hasInChangeSet(id, changeSetId)) continue;
				const rec = await this.captureLocked(stores, id, cs.cause, changeSetId, true);
				if (rec) made.push(rec.versionId);
			}
			return made;
		});
	}

	/** A `Manual` checkpoint (also the test seam for an immediate capture). */
	captureNow(
		entityId: string,
		cause: VersionCause = VersionCause.Manual,
	): Promise<EntityVersionRecord | null> {
		return this.run(async () => {
			const stores = await this.requireStores();
			return this.captureLocked(stores, entityId, cause, null, cause !== VersionCause.Idle);
		});
	}

	async list(entityId: string): Promise<EntityVersionRecord[]> {
		const stores = await this.requireStores();
		return stores.versions.listByEntity(entityId);
	}

	async getVersion(versionId: string): Promise<EntityVersionRecord | null> {
		const stores = await this.requireStores();
		return stores.versions.get(versionId);
	}

	preview(
		record: EntityVersionRecord,
	): Promise<{ bodyText: string; properties: Record<string, unknown> }> {
		return this.run(async () => {
			const body = await this.options.worker.preview(record.entityId, frameOf(record));
			return { bodyText: body.bodyText, properties: record.properties };
		});
	}

	/** Restore `versionId` onto its entity. The caller has already resolved
	 *  the version server-side and authorised the write. */
	restore(input: {
		app: string;
		versionId: string;
		principal: ChangeSetPrincipal;
	}): Promise<string> {
		return this.run(async () => {
			const stores = await this.requireStores();
			const record = stores.versions.get(input.versionId);
			if (!record) throw named("Invalid", "history: unknown version");
			// An agent's restore checkpoint is filed under its own change set,
			// so retention charges it to that agent's per-principal cap.
			const changeSetId = isAgent(input.principal)
				? this.beginChangeSetLocked(stores, VersionCause.BeforeRestore, [input.principal])
				: null;
			const before = await this.captureLocked(
				stores,
				record.entityId,
				VersionCause.BeforeRestore,
				changeSetId,
				true,
			);
			if (!before) throw named("Invalid", `history: ${record.entityId} not found`);
			await this.restoreLocked(input.app, record, isAgent(input.principal));
			this.noteWrite(record.entityId, [input.principal]);
			return before.versionId;
		});
	}

	/**
	 * Revert every entity of `changeSetId` to its checkpoint. An entity edited
	 * after its checkpoint by a principal OUTSIDE the change set is skipped, never
	 * clobbered; `gate` is the caller's per-entity write authority.
	 */
	revertChangeSet(input: {
		app: string;
		changeSetId: string;
		principal: ChangeSetPrincipal;
		gate: (entity: {
			id: string;
			type: string;
			properties: Record<string, unknown>;
		}) => RevertGateResult | Promise<RevertGateResult>;
	}): Promise<{ results: RevertEntityResult[]; revertChangeSetId: string }> {
		return this.run(async () => {
			const stores = await this.requireStores();
			const cs = stores.changeSets.get(input.changeSetId);
			if (!cs) throw named("Invalid", "history: unknown change set");
			const own = new Set(cs.principals.map(principalKey));
			const firstPerEntity = new Map<string, EntityVersionRecord>();
			for (const rec of stores.versions.listByChangeSet(cs.changeSetId)) {
				if (!firstPerEntity.has(rec.entityId)) firstPerEntity.set(rec.entityId, rec);
			}
			const revertChangeSetId = this.beginChangeSetLocked(stores, VersionCause.BeforeRestore, [
				input.principal,
			]);
			const results: RevertEntityResult[] = [];
			for (const [entityId, checkpoint] of firstPerEntity) {
				const entity = stores.entities.get(entityId);
				if (!entity) {
					results.push({ entityId, outcome: RevertOutcome.Deleted });
					continue;
				}
				const gate = await input.gate(entity);
				if (gate !== RevertGateResult.Allow) {
					results.push({
						entityId,
						outcome: gate === RevertGateResult.Locked ? RevertOutcome.Locked : RevertOutcome.Denied,
					});
					continue;
				}
				if (this.editedSince(stores, checkpoint, own)) {
					results.push({ entityId, outcome: RevertOutcome.EditedSince });
					continue;
				}
				await this.captureLocked(stores, entityId, VersionCause.BeforeRestore, revertChangeSetId, true);
				await this.restoreLocked(input.app, checkpoint, isAgent(input.principal));
				this.noteWrite(entityId, [input.principal]);
				results.push({ entityId, outcome: RevertOutcome.Reverted });
			}
			return { results, revertChangeSetId };
		});
	}

	/** Run retention now. Returns how many checkpoints were dropped. */
	prune(): Promise<number> {
		return this.run(() => this.pruneLocked());
	}

	/** Capture every entity with unflushed writes now (vault close). */
	flush(): Promise<void> {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		const ids = [...this.pending.keys()];
		return this.run(async () => {
			const stores = await this.options.getStores();
			if (!stores) return;
			for (const id of ids) await this.captureLocked(stores, id, VersionCause.Idle, null, false);
		});
	}

	/** Resolves once every queued history operation has settled. */
	async idle(): Promise<void> {
		await this.chain.catch(() => undefined);
	}

	dispose(): void {
		this.disposed = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.pending.clear();
	}

	/** Writers recorded for `entityId` that no checkpoint holds yet. */
	pendingPrincipals(entityId: string): StoredPrincipal[] {
		return [...(this.pending.get(entityId)?.values() ?? [])];
	}

	private rememberIdle(entityId: string, at: number): void {
		this.lastIdleAt.delete(entityId);
		this.lastIdleAt.set(entityId, at);
		if (this.lastIdleAt.size <= IDLE_MEMO_MAX) return;
		const oldest = this.lastIdleAt.keys().next().value;
		if (oldest !== undefined) this.lastIdleAt.delete(oldest);
	}

	private arm(entityId: string, dueAt: number): void {
		const prior = this.timers.get(entityId);
		if (prior) clearTimeout(prior);
		const lastIdle = this.lastIdleAt.get(entityId);
		const at = lastIdle === undefined ? dueAt : Math.max(dueAt, lastIdle + this.idleMinIntervalMs);
		const timer = setTimeout(() => this.fireIdle(entityId), Math.max(0, at - this.now()));
		(timer as { unref?: () => void }).unref?.();
		this.timers.set(entityId, timer);
	}

	private fireIdle(entityId: string): void {
		this.timers.delete(entityId);
		if (this.disposed) return;
		void this.run(async () => {
			const stores = await this.options.getStores();
			if (!stores) return;
			if (!this.lastIdleAt.has(entityId)) {
				const latest = stores.versions.latestForEntity(entityId);
				if (latest?.cause === VersionCause.Idle) this.rememberIdle(entityId, latest.at);
			}
			const lastIdle = this.lastIdleAt.get(entityId);
			if (lastIdle !== undefined && this.now() < lastIdle + this.idleMinIntervalMs) {
				this.arm(entityId, this.now());
				return;
			}
			await this.captureLocked(stores, entityId, VersionCause.Idle, null, false);
			if (this.now() - this.lastRetentionAt >= this.retentionIntervalMs) await this.pruneLocked();
		}).catch((error) => {
			console.warn(`[history] idle capture of ${entityId} failed: ${(error as Error).message}`);
		});
	}

	private beginChangeSetLocked(
		stores: HistoryStores,
		cause: VersionCause,
		principals: readonly ChangeSetPrincipal[],
	): string {
		const changeSetId = `cs_${this.newId()}`;
		stores.changeSets.create({
			changeSetId,
			cause,
			principals: principals.map((p) => ({ kind: p.kind, id: p.id })),
			createdAt: this.now(),
		});
		return changeSetId;
	}

	private async requireStores(): Promise<HistoryStores> {
		const stores = await this.options.getStores();
		if (!stores) throw named("Unavailable", "history: no active vault");
		return stores;
	}

	private async captureLocked(
		stores: HistoryStores,
		entityId: string,
		cause: VersionCause,
		changeSetId: string | null,
		force: boolean,
	): Promise<EntityVersionRecord | null> {
		if (!isSafeEntityId(entityId) || !stores.entities.get(entityId)) {
			this.pending.delete(entityId);
			return null;
		}
		const last = stores.versions.latestForEntity(entityId);
		const reply = await this.options.worker.capture(entityId, last?.stateKey ?? null);
		let frame: HistFrameRef;
		if (reply.captured) {
			frame = { offset: reply.offset, length: reply.length };
			this.options.onCapture?.({ entityId, cause, encodeMs: reply.encodeMs, bytes: reply.length });
		} else if (force && last) {
			frame = frameOf(last);
		} else {
			this.pending.delete(entityId);
			if (cause === VersionCause.Idle) this.rememberIdle(entityId, this.now());
			return null;
		}
		const row = stores.entities.get(entityId);
		if (!row) return null;
		const record: EntityVersionRecord = {
			versionId: this.newId(),
			entityId,
			at: this.now(),
			cause,
			changeSetId,
			principals: this.pendingPrincipals(entityId),
			frameOffset: frame.offset,
			frameLength: frame.length,
			stateKey: reply.stateKey,
			properties: row.properties,
		};
		stores.versions.insert(record);
		this.pending.delete(entityId);
		const timer = this.timers.get(entityId);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(entityId);
		}
		if (cause === VersionCause.Idle) this.rememberIdle(entityId, record.at);
		return record;
	}

	private async restoreLocked(
		app: string,
		record: EntityVersionRecord,
		agent: boolean,
	): Promise<void> {
		const restorer = this.options.getRestorer();
		if (!restorer) throw named("Unavailable", "history: restore path not wired");
		await restorer({
			app,
			entityId: record.entityId,
			properties: record.properties,
			frame: frameOf(record),
			agent,
		});
	}

	private editedSince(
		stores: HistoryStores,
		checkpoint: EntityVersionRecord,
		own: ReadonlySet<string>,
	): boolean {
		const foreign = (p: StoredPrincipal): boolean =>
			!own.has(principalKey(p)) && p.lastWriteAt >= checkpoint.at;
		for (const later of stores.versions.listAfter(checkpoint.entityId, checkpoint.at)) {
			if (later.principals.some(foreign)) return true;
		}
		return this.pendingPrincipals(checkpoint.entityId).some(foreign);
	}

	private async pruneLocked(): Promise<number> {
		const stores = await this.options.getStores();
		if (!stores) return 0;
		this.lastRetentionAt = this.now();
		const rows = stores.versions.listForRetention();
		if (rows.length === 0) return 0;
		const csPrincipals = stores.changeSets.listPrincipals();
		const candidates: RetentionCandidate[] = rows.map((r) => {
			const agent =
				(r.cause === VersionCause.AgentRun || r.cause === VersionCause.BeforeRestore) && r.changeSetId
					? (csPrincipals.get(r.changeSetId)?.find((p) => p.kind === HistoryPrincipalKind.Agent) ?? null)
					: null;
			return {
				versionId: r.versionId,
				entityId: r.entityId,
				at: r.at,
				cause: r.cause,
				changeSetId: r.changeSetId,
				agentPrincipal: agent ? principalKey(agent) : null,
				frameKey: `${r.entityId}\u0000${r.frameOffset}`,
				frameBytes: r.frameLength,
				ownBytes: r.propertiesBytes,
			};
		});
		const plan = planRetention(candidates, this.now(), await this.options.getPolicy());
		if (plan.drop.size === 0) return 0;
		stores.versions.deleteMany([...plan.drop.keys()]);
		const affected = new Set(rows.filter((r) => plan.drop.has(r.versionId)).map((r) => r.entityId));
		for (const entityId of affected) {
			const keep = new Map<number, HistFrameRef>();
			for (const r of rows) {
				if (r.entityId !== entityId || plan.drop.has(r.versionId)) continue;
				keep.set(r.frameOffset, { offset: r.frameOffset, length: r.frameLength });
			}
			const moved = await this.options.worker.compact(entityId, [...keep.values()]);
			stores.versions.relocateFrames(entityId, new Map(moved.filter(([from, to]) => from !== to)));
		}
		stores.changeSets.deleteOrphans();
		return plan.drop.size;
	}

	private run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.chain.then(fn, fn);
		this.chain = next.catch(() => undefined);
		return next;
	}
}

function isAgent(principal: ChangeSetPrincipal): boolean {
	return principal.kind === HistoryPrincipalKind.Agent;
}

function frameOf(record: EntityVersionRecord): HistFrameRef {
	return { offset: record.frameOffset, length: record.frameLength };
}

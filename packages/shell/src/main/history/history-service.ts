/**
 * `history` — the broker service over version history (10.16).
 *
 * No capability of its own (`caps: []` on the wire): like `entities`, the type
 * of the object is only known once its row is read, so this handler is the
 * sole authority. Every method resolves the version and its entity HERE — a
 * client-supplied `(entityId, versionId)` pairing is only accepted when the
 * stored row says the version belongs to that entity.
 *
 *   list            entities.read:<type>                 → any role
 *   preview         entities.read:<type>                 → not a Viewer (OQ-VH-2)
 *   restore         entities.write:<type>, not locked    → Editor+ or unshared
 *   revertChangeSet per entity, as restore; the rest is skipped, and only
 *                   entities the caller may read are named
 *
 * `restore` / `revertChangeSet` are rate limited per app (each one force-
 * captures `BeforeRestore` checkpoints), and an agent caller (one carrying an
 * agent `provenance`, exactly as on `entities` writes) acts — and is charged
 * in retention — as itself, not as the user.
 *
 * Fail closed: a ledger outage is `Unavailable`; a role that cannot be
 * resolved is treated as Viewer. A missing and an unreadable entity give the
 * SAME error, so the service is no existence oracle.
 */

import { LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import {
	type ChangeSetRevertResult,
	HistoryAccess,
	type HistoryPrincipal,
	HistoryPrincipalKind,
	RevertSkipReason,
	type VersionHistoryList,
	type VersionPreview,
	type VersionRestoreResult,
	parseProvenanceRequest,
} from "@brainstorm-os/sdk-types";
import { isLockedProperties } from "@brainstorm-os/sdk/entity-lock";
import type { ServiceHandler } from "../../ipc/broker";
import { deriveEntityTitle } from "../entities/derive-title";
import { isShellOwnedEntityType } from "../entities/shell-owned-types";
import type {
	ChangeSetPrincipal,
	EntitiesRepository,
	EntityRow,
	StoredPrincipal,
} from "../storage/entities-repo";
import { isSafeEntityId } from "../storage/entity-id";
import { diffVersionProperties } from "./property-diff";
import { RevertGateResult, RevertOutcome, type VersionHistory } from "./version-history";

export const HISTORY_SERVICE = "history";

/** The caller's standing on a possibly-shared object (Collab-C5 roles). */
export enum HistoryRole {
	/** Not shared (≤1 active member) — the local user owns it outright. */
	NotShared = "not-shared",
	Owner = "owner",
	Editor = "editor",
	Viewer = "viewer",
}

export type HistoryServiceOptions = {
	getHistory: () => VersionHistory | null;
	getRepo: () => Promise<EntitiesRepository | null>;
	getLedger: () => Promise<CapabilityLedger | null>;
	resolveRole: (entityId: string) => Promise<HistoryRole>;
	selfPrincipal: () => ChangeSetPrincipal | null;
	/** Display label for a principal (contact name, agent name); the raw id
	 *  when nothing better is known. */
	labelPrincipal?: (principal: ChangeSetPrincipal) => string;
	now?: () => number;
};

/** Restores + change-set reverts one app may start per window. */
export const HISTORY_RESTORE_RATE_MAX = 30;
export const HISTORY_RESTORE_RATE_WINDOW_MS = 60_000;

enum Verb {
	Read = "read",
	Write = "write",
}

const SAFE_VERSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function named(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

function arg(envelope: { args: unknown[] }): unknown {
	return envelope.args[0];
}

function stringField(value: unknown, field: string): string {
	if (!value || typeof value !== "object") throw named("Invalid", `history: missing ${field}`);
	const v = (value as Record<string, unknown>)[field];
	if (typeof v !== "string") throw named("Invalid", `history: ${field} must be a string`);
	return v;
}

function notFound(): Error {
	return named("Invalid", "history: no such object or version");
}

export function makeHistoryServiceHandler(options: HistoryServiceOptions): ServiceHandler {
	const label = (p: ChangeSetPrincipal): string => {
		try {
			return options.labelPrincipal?.(p) ?? p.id;
		} catch {
			return p.id;
		}
	};

	const roleOf = async (entityId: string): Promise<HistoryRole> => {
		try {
			return await options.resolveRole(entityId);
		} catch {
			return HistoryRole.Viewer;
		}
	};

	const canRestoreAsRole = (role: HistoryRole): boolean => role !== HistoryRole.Viewer;

	const clock = options.now ?? Date.now;
	const recentRestores = new Map<string, number[]>();
	const chargeRestore = (app: string): void => {
		const now = clock();
		const recent = (recentRestores.get(app) ?? []).filter(
			(at) => now - at < HISTORY_RESTORE_RATE_WINDOW_MS,
		);
		if (recent.length >= HISTORY_RESTORE_RATE_MAX) {
			throw named("Denied", "history: too many restores — try again in a minute");
		}
		recent.push(now);
		recentRestores.set(app, recent);
	};

	return async (envelope) => {
		const history = options.getHistory();
		const repo = await options.getRepo();
		const ledger = await options.getLedger();
		if (!history || !repo || !ledger) throw named("Unavailable", "history: no active vault session");
		const app = envelope.app;

		const can = (verb: Verb, type: string): boolean => {
			if (verb === Verb.Write && isShellOwnedEntityType(type)) return false;
			try {
				return ledger.has(app, `entities.${verb}:${type}`);
			} catch (error) {
				if (error instanceof LedgerUnavailableError) {
					throw named("Unavailable", "history: capability ledger unavailable");
				}
				throw error;
			}
		};

		const readableRow = (entityId: string): EntityRow => {
			if (!isSafeEntityId(entityId)) throw notFound();
			const row = repo.get(entityId);
			if (!row || !can(Verb.Read, row.type)) throw notFound();
			return row;
		};

		const self = options.selfPrincipal();
		const toPrincipal = (p: StoredPrincipal): HistoryPrincipal => ({
			kind: p.kind,
			id: p.id,
			label: label(p),
			isSelf: self !== null && p.kind === self.kind && p.id === self.id,
		});

		const resolveVersion = async (input: unknown) => {
			const entityId = stringField(input, "entityId");
			const versionId = stringField(input, "versionId");
			if (!SAFE_VERSION_ID_RE.test(versionId)) throw notFound();
			const row = readableRow(entityId);
			const record = await history.getVersion(versionId);
			if (!record || record.entityId !== row.id) throw notFound();
			return { row, record };
		};

		const actingPrincipal = (input: unknown): ChangeSetPrincipal => {
			const provenance =
				input && typeof input === "object" ? (input as { provenance?: unknown }).provenance : undefined;
			if (parseProvenanceRequest(provenance)) return agentPrincipal(app);
			if (!self) throw named("Unavailable", "history: no vault identity");
			return self;
		};

		switch (envelope.method) {
			case "list": {
				const entityId = arg(envelope);
				if (typeof entityId !== "string") throw named("Invalid", "history.list: entityId");
				const row = readableRow(entityId);
				const role = await roleOf(row.id);
				const access =
					role === HistoryRole.Viewer
						? HistoryAccess.ListOnly
						: can(Verb.Write, row.type)
							? HistoryAccess.Restore
							: HistoryAccess.Preview;
				const versions = (await history.list(row.id)).map((v) => ({
					versionId: v.versionId,
					entityId: v.entityId,
					at: v.at,
					cause: v.cause,
					changeSetId: v.changeSetId,
					principals: v.principals.map(toPrincipal),
				}));
				return { access, versions } satisfies VersionHistoryList;
			}

			case "preview": {
				const { row, record } = await resolveVersion(arg(envelope));
				if ((await roleOf(row.id)) === HistoryRole.Viewer) {
					throw named("Denied", "history.preview: Viewers see the version list only");
				}
				const body = await history.preview(record);
				return {
					versionId: record.versionId,
					at: record.at,
					properties: record.properties,
					changes: diffVersionProperties(record.properties, row.properties),
					bodyText: body.bodyText,
				} satisfies VersionPreview;
			}

			case "restore": {
				const { row, record } = await resolveVersion(arg(envelope));
				if (!can(Verb.Write, row.type)) {
					throw named("Denied", `history.restore: no entities.write for ${row.type}`);
				}
				if (!canRestoreAsRole(await roleOf(row.id))) {
					throw named("Denied", "history.restore: Editors and above restore a shared object");
				}
				if (isLockedProperties(row.properties)) {
					throw named("Denied", "history.restore: the object is locked (read-only)");
				}
				const principal = actingPrincipal(arg(envelope));
				chargeRestore(app);
				const beforeRestoreVersionId = await history.restore({
					app,
					versionId: record.versionId,
					principal,
				});
				return { beforeRestoreVersionId } satisfies VersionRestoreResult;
			}

			case "revertChangeSet": {
				const input = arg(envelope);
				const changeSetId =
					input && typeof input === "object" ? (input as { changeSetId?: unknown }).changeSetId : input;
				if (typeof changeSetId !== "string" || !SAFE_VERSION_ID_RE.test(changeSetId)) {
					throw named("Invalid", "history.revertChangeSet: changeSetId");
				}
				const principal = actingPrincipal(input);
				chargeRestore(app);
				const outcome = await history.revertChangeSet({
					app,
					changeSetId,
					principal,
					gate: async (entity) => {
						if (!can(Verb.Write, entity.type)) return RevertGateResult.Deny;
						if (!canRestoreAsRole(await roleOf(entity.id))) return RevertGateResult.Deny;
						if (isLockedProperties(entity.properties)) return RevertGateResult.Locked;
						return RevertGateResult.Allow;
					},
				});
				const result: ChangeSetRevertResult = {
					reverted: [],
					skipped: [],
					hiddenCount: 0,
					revertChangeSetId: outcome.revertChangeSetId,
				};
				for (const r of outcome.results) {
					const row = repo.get(r.entityId);
					if (!row || !can(Verb.Read, row.type)) {
						result.hiddenCount += 1;
						continue;
					}
					if (r.outcome === RevertOutcome.Reverted) {
						result.reverted.push(r.entityId);
						continue;
					}
					result.skipped.push({
						entityId: r.entityId,
						title: deriveEntityTitle(row.properties),
						reason: SKIP_REASON[r.outcome],
					});
				}
				return result;
			}

			default:
				throw named("Invalid", `unknown history method: ${envelope.method}`);
		}
	};
}

const SKIP_REASON: Readonly<
	Record<Exclude<RevertOutcome, RevertOutcome.Reverted>, RevertSkipReason>
> = {
	[RevertOutcome.EditedSince]: RevertSkipReason.EditedSince,
	[RevertOutcome.Deleted]: RevertSkipReason.Deleted,
	[RevertOutcome.Locked]: RevertSkipReason.Locked,
	[RevertOutcome.Denied]: RevertSkipReason.Denied,
};

/** A member principal for a vault identity. */
export function memberPrincipal(publicKeyB64Url: string): ChangeSetPrincipal {
	return { kind: HistoryPrincipalKind.Member, id: publicKeyB64Url };
}

/** An agent principal for the broker-verified app that acted. */
export function agentPrincipal(appId: string): ChangeSetPrincipal {
	return { kind: HistoryPrincipalKind.Agent, id: appId };
}

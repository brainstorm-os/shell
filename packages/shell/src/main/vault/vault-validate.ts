/**
 * Vault consistency checker (Stage 10.8 — OQ-212 RESOLVED warn-only at v1).
 *
 * Runs structural invariants against an opened vault to surface
 * drift between the freeze surface (vault.json fields, SQLite rows,
 * Yjs files, the sync seq state, the `meta.devices` Y.Array) and the
 * actual on-disk reality. **Warn-only**: every check returns
 * `ValidationWarning[]` rather than throwing; the boot-time path
 * fires fire-and-forget after `openVault` succeeds so a freshly-broken
 * vault is still openable in case the user wants to extract data
 * before fixing. The CLI surface
 * (`packages/shell/scripts/vault-validate.ts`) prints the report and
 * exits zero (warn-only at v1).
 *
 * Checks at v1:
 *
 *   1. EntityDekPresent       — every live entities.id has at least one entity_deks row (10.1 invariant).
 *   2. EntityDekDangling      — every entity_deks.entity_id references a live entity (FK is present
 *                                in schema, but a soft-deleted parent leaves a stale row).
 *   3. DeviceRecordsValid     — when vault.json.syncRelay is set, every signed add-device record on
 *                                brainstorm-VaultProperties' meta.devices Y.Array verifies; an empty
 *                                set is acceptable.
 *   4. SeqJsonReadable        — <vault>/sync/seq.json either parses or is absent (the SeqTracker
 *                                already tolerates corruption at runtime — this surfaces it as a
 *                                diagnostic).
 *   5. AtRestModeMatches      — `vault.json.atRestMode` agrees with `probeAtRestMode()`'s outcome.
 *                                Mismatches that would have been refused at open-time can't appear
 *                                here (openVault threw), so this fires only on FirstStamp / parallel
 *                                regressions.
 *  6. OrphanYDocFile — every `<id>.ydoc` under `<vault>/data/docs/<prefix>/` corresponds to
 *                                a live or soft-deleted entities row; hard-deleted leftovers are
 *                                flagged. The reserved vault-level docs
 *                                (`brainstorm-Dashboard` + `brainstorm-VaultProperties`) are exempt.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	AtRestMode,
	type AtRestProbeResult,
	AtRestReconcileOutcome,
	probeAtRestMode,
	reconcileAtRestMode,
} from "@brainstorm-os/sqlite/at-rest-mode";
import { DASHBOARD_DOC_ID } from "../dashboard/dashboard-store";
import { type SignedAddDeviceRecord, verifyAddDeviceRecord } from "../pairing/devices-store";
import type { YDocStore } from "../storage/ydoc-store";
import { VAULT_PROPERTIES_DOC_ID } from "./vault-properties-store";

export enum ValidationCheck {
	EntityDekPresent = "entity-dek-present",
	EntityDekDangling = "entity-dek-dangling",
	DeviceRecordsValid = "device-records-valid",
	SeqJsonReadable = "seq-json-readable",
	AtRestModeMatches = "at-rest-mode-matches",
	OrphanYDocFile = "orphan-ydoc-file",
}

export type ValidationWarning = {
	check: ValidationCheck;
	detail: string;
	fixable: boolean;
};

export type ValidationReport = {
	ok: boolean;
	warnings: ValidationWarning[];
};

export type ValidateEntityRow = {
	id: string;
	deleted: boolean;
};

export type ValidateOptions = {
	/**
	 * Live entities rows. The validate runner doesn't open a fresh DB —
	 * the caller passes the rows it already has (boot path = a single
	 * read of `entities.id, deleted_at IS NOT NULL`).
	 */
	entities: readonly ValidateEntityRow[];
	/** All entity_deks rows (`{entityId}` is enough for the checks). */
	entityDeks: readonly { entityId: string }[];
	/**
	 * The Y.Array of signed device records (deep-cloned snapshot). When the
	 * vault has never paired a device this is an empty array, NOT undefined
	 * — the absence of `meta.devices` is its own signal.
	 */
	deviceRecords: readonly SignedAddDeviceRecord[];
	/** User-Ed25519 pubkey from the active session — needed for device
	 *  record verification. When absent (no identity), the check is skipped. */
	userEd25519Pub?: Uint8Array;
	/**
	 * The on-disk `vault.json.syncRelay`. The DeviceRecordsValid check
	 * only runs when this is set (no relay = local-only vault, devices
	 * aren't on the wire so an unsigned record can't lock the user out).
	 */
	syncRelayConfigured: boolean;
	/** The `vault.json.atRestMode` read at open time. */
	recordedAtRestMode?: "encrypted" | "plaintext";
	/** Override the at-rest probe (tests). */
	atRestProbe?: AtRestProbeResult;
	/** YDocStore handle for orphan detection. Pass null to skip the check. */
	yDocStore: YDocStore | null;
};

const RESERVED_YDOC_IDS = new Set<string>([DASHBOARD_DOC_ID, VAULT_PROPERTIES_DOC_ID]);

export async function validateVault(
	vaultPath: string,
	options: ValidateOptions,
): Promise<ValidationReport> {
	const warnings: ValidationWarning[] = [];
	const liveEntityIds = new Set<string>();
	const knownEntityIds = new Set<string>();
	for (const row of options.entities) {
		knownEntityIds.add(row.id);
		if (!row.deleted) liveEntityIds.add(row.id);
	}

	const entityIdsWithDek = new Set<string>();
	for (const row of options.entityDeks) {
		entityIdsWithDek.add(row.entityId);
		if (!knownEntityIds.has(row.entityId)) {
			warnings.push({
				check: ValidationCheck.EntityDekDangling,
				detail: `entity_deks row references missing entity ${row.entityId}`,
				fixable: true,
			});
		}
	}
	for (const id of liveEntityIds) {
		if (!entityIdsWithDek.has(id)) {
			warnings.push({
				check: ValidationCheck.EntityDekPresent,
				detail: `entity ${id} has no entity_deks row (Stage 10.1 invariant)`,
				fixable: true,
			});
		}
	}

	if (options.syncRelayConfigured && options.userEd25519Pub) {
		for (const record of options.deviceRecords) {
			const verified = verifyAddDeviceRecord(record, options.userEd25519Pub);
			if (!verified) {
				warnings.push({
					check: ValidationCheck.DeviceRecordsValid,
					detail: `signed device record ${record.deviceEd25519Pub.slice(0, 12)}… failed signature verification`,
					fixable: false,
				});
			}
		}
	}

	const seqWarning = await validateSeqJson(vaultPath);
	if (seqWarning) warnings.push(seqWarning);

	const atRestWarning = await validateAtRestMode(options);
	if (atRestWarning) warnings.push(atRestWarning);

	if (options.yDocStore) {
		const orphans = await collectOrphanYDocFiles(options.yDocStore, knownEntityIds);
		for (const orphan of orphans) {
			warnings.push({
				check: ValidationCheck.OrphanYDocFile,
				detail: `orphan ydoc file ${orphan} has no matching entities row`,
				fixable: true,
			});
		}
	}

	return { ok: warnings.length === 0, warnings };
}

async function validateSeqJson(vaultPath: string): Promise<ValidationWarning | null> {
	const path = join(vaultPath, "sync", "seq.json");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNotFound(error)) return null;
		return {
			check: ValidationCheck.SeqJsonReadable,
			detail: `seq.json read failed: ${(error as Error).message}`,
			fixable: true,
		};
	}
	try {
		JSON.parse(raw);
		return null;
	} catch (error) {
		return {
			check: ValidationCheck.SeqJsonReadable,
			detail: `seq.json contains malformed JSON: ${(error as Error).message}`,
			fixable: true,
		};
	}
}

async function validateAtRestMode(options: ValidateOptions): Promise<ValidationWarning | null> {
	if (options.recordedAtRestMode === undefined) return null;
	const probe = options.atRestProbe ?? (await probeAtRestMode());
	const recordedMode =
		options.recordedAtRestMode === "encrypted" ? AtRestMode.Encrypted : AtRestMode.Plaintext;
	try {
		const result = reconcileAtRestMode(recordedMode, probe, "<validate>");
		if (result.outcome === AtRestReconcileOutcome.Matches) return null;
		if (result.outcome === AtRestReconcileOutcome.UpgradeReady) {
			return {
				check: ValidationCheck.AtRestModeMatches,
				detail: "vault recorded plaintext, driver is encrypted — upgrade pending",
				fixable: true,
			};
		}
		return {
			check: ValidationCheck.AtRestModeMatches,
			detail: `at-rest reconcile outcome=${result.outcome} (recorded=${recordedMode}, probed=${probe.mode})`,
			fixable: false,
		};
	} catch (error) {
		return {
			check: ValidationCheck.AtRestModeMatches,
			detail: `at-rest reconcile would refuse open: ${(error as Error).message}`,
			fixable: false,
		};
	}
}

async function collectOrphanYDocFiles(
	yDocStore: YDocStore,
	knownEntityIds: ReadonlySet<string>,
): Promise<string[]> {
	const probePath = yDocStore.pathFor("xxx");
	const docsDir = dirname(dirname(probePath));
	let prefixes: string[];
	try {
		prefixes = await readdir(docsDir);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	const orphans: string[] = [];
	for (const prefix of prefixes) {
		const prefixDir = join(docsDir, prefix);
		let entries: string[];
		try {
			const info = await stat(prefixDir);
			if (!info.isDirectory()) continue;
			entries = await readdir(prefixDir);
		} catch (error) {
			if (isNotFound(error)) continue;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".ydoc")) continue;
			const id = entry.slice(0, -".ydoc".length);
			if (RESERVED_YDOC_IDS.has(id)) continue;
			if (!knownEntityIds.has(id)) orphans.push(`${prefix}/${entry}`);
		}
	}
	return orphans;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === "ENOENT"
	);
}

/**
 * BinService — the shell-only Bin / Trash (Stage 9.19).
 *
 * Soft-delete already happens in the entities service (`entities.delete`
 * → `EntitiesRepository.softDelete`). This service is the *recovery* side:
 * list what's in the Bin, restore it, or purge it permanently. It is
 * **shell-internal by design** (OQ-BIN-1): restore writes back into the
 * owning app's data space, which a sandboxed app cannot do, so these
 * verbs never traverse the broker / per-app capability ledger — the Bin
 * surface is a privileged shell renderer talking to ipcMain directly,
 * exactly like Settings / Marketplace.
 *
 * Pure orchestration on top of `EntitiesRepository` (Stage 5 repo-pattern
 * rule — no SQL here). Title + icon derivation reuses the *same*
 * `deriveEntityTitle` + `parseIcon` the dashboard pin resolver and the
 * search collector use, so a deleted object looks identical in the Bin
 * and everywhere else (no drift — [[per-object-icons-everywhere]]).
 */

import type { Icon } from "@brainstorm-os/sdk-types";
import { parseIcon } from "@brainstorm-os/sdk/entity-icon";
import { deriveEntityTitle } from "../entities/derive-title";
import type { EntitiesRepository } from "../storage/entities-repo";

/** One row in the Bin, shaped for the renderer (no raw property blob
 *  crosses IPC — just what the list renders). `title` is never empty:
 *  it falls back to the id so every entry is identifiable even for an
 *  object that never had a title/name. */
export type BinItem = {
	id: string;
	type: string;
	title: string;
	icon: Icon | null;
	deletedAt: number;
};

export type BinServiceOptions = {
	/** The entities repo for the active vault, or null when no vault is
	 *  open (every verb then degrades to an empty / false result — the
	 *  Bin is simply unavailable, never an error dialog). */
	getRepo: () => EntitiesRepository | null;
	/** Free the on-disk blob a purged upload owned, once nothing else
	 *  references it. Injected — the encrypted asset store lives in the vault
	 *  session, not the repo; omitted in tests / contexts with no store, where
	 *  purge still removes the entity row (blob simply isn't reaped). */
	deleteAsset?: (assetId: string) => Promise<void>;
	/** Clock. Injected for deterministic tests. */
	now?: () => number;
};

/** Retention window (days) for soft-deleted entities — 9.8.8 per
 *  §Delete: items stay restorable for a
 *  configurable window (default 30 days), then purge lazily on the next
 *  Bin listing. `RETENTION_FOREVER` (0) disables the sweep entirely. */
export const DEFAULT_BIN_RETENTION_DAYS = 30;
export const RETENTION_FOREVER = 0;
/** The selectable presets the Settings panel offers. */
export const BIN_RETENTION_PRESETS: readonly number[] = [7, 30, 90, 365, RETENTION_FOREVER];

export function isBinRetentionDays(value: unknown): value is number {
	return typeof value === "number" && BIN_RETENTION_PRESETS.includes(value);
}

const DAY_MS = 86_400_000;

export class BinService {
	private readonly clock: () => number;

	constructor(private readonly options: BinServiceOptions) {
		this.clock = options.now ?? (() => Date.now());
	}

	/** Soft-deleted entities, most-recently-deleted first. */
	list(): BinItem[] {
		const repo = this.options.getRepo();
		if (!repo) return [];
		return repo.listDeleted().map((row) => ({
			id: row.id,
			type: row.type,
			title: deriveEntityTitle(row.properties) || row.id,
			icon: parseIcon(row.properties.icon),
			deletedAt: row.deletedAt,
		}));
	}

	/** Restore one entity out of the Bin. Idempotent — false when the id
	 *  is unknown or already live. */
	restore(id: string): boolean {
		const repo = this.options.getRepo();
		if (!repo || typeof id !== "string" || id === "") return false;
		return repo.restore(id, this.clock());
	}

	/** Permanently purge one entity. Idempotent — false when the id is
	 *  unknown or not in the Bin (a live entity can never be purged here;
	 *  the repo refuses). On success, frees the upload blob it owned once no
	 *  other entity (live or still-binned) references it. */
	async purge(id: string): Promise<boolean> {
		const repo = this.options.getRepo();
		if (!repo || typeof id !== "string" || id === "") return false;
		const assetId = assetIdOf(repo.listDeleted().find((row) => row.id === id)?.properties);
		if (!repo.hardDelete(id)) return false;
		await this.reapAsset(assetId);
		return true;
	}

	/**
	 * Lazy retention sweep (9.8.8): purge entities whose `deletedAt` is
	 * older than the retention window. Runs on Bin listing (the
	 * iOS-Recently-Deleted pattern — no background timer to leak), so an
	 * untouched Bin never destroys anything mid-session. `retentionDays`
	 * ≤ 0 (= `RETENTION_FOREVER`) disables the sweep. Returns the count
	 * purged so callers can fan out the entity-change refresh.
	 */
	purgeExpired(retentionDays: number): number {
		const repo = this.options.getRepo();
		if (!repo || !Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
		const cutoff = this.clock() - retentionDays * DAY_MS;
		let purged = 0;
		for (const item of repo.listDeleted()) {
			if (item.deletedAt < cutoff && repo.hardDelete(item.id)) purged += 1;
		}
		return purged;
	}

	/** Empty the Bin — purge every soft-deleted entity. Returns the count
	 *  actually purged (a snapshot is taken first so a concurrent restore
	 *  can't make this loop forever). Each purged upload's blob is reaped. */
	async empty(): Promise<number> {
		const repo = this.options.getRepo();
		if (!repo) return 0;
		let purged = 0;
		for (const item of repo.listDeleted()) {
			const assetId = assetIdOf(item.properties);
			if (repo.hardDelete(item.id)) {
				purged += 1;
				await this.reapAsset(assetId);
			}
		}
		return purged;
	}

	/** Delete the blob iff it's now unreachable: no live entity references it
	 *  (`assetId` property) and no other object still sits in the Bin holding
	 *  it, so restoring a sibling copy can never resurrect a missing blob. */
	private async reapAsset(assetId: string | null): Promise<void> {
		const del = this.options.deleteAsset;
		const repo = this.options.getRepo();
		if (!del || !repo || !assetId) return;
		if (repo.listIdsWithProperty("assetId", assetId).length > 0) return;
		if (repo.listDeleted().some((row) => assetIdOf(row.properties) === assetId)) return;
		await del(assetId);
	}
}

function assetIdOf(properties: Record<string, unknown> | undefined): string | null {
	const value = properties?.assetId;
	return typeof value === "string" && value !== "" ? value : null;
}

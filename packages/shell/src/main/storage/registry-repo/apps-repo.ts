/**
 * AppsRepository — CRUD on `registry.db.apps`.
 *
 * All SQL for the `apps` table lives here. Feature code (AppInstaller, future
 * launcher) calls typed methods; SQL strings never escape this file.
 *
 * Per §Uninstall: rows are soft-deleted via
 * `uninstalled_at`. Re-installing the same id reactivates the row (the
 * primary key is stable; INSERT OR REPLACE clears `uninstalled_at`).
 */

import type { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { AppSignatureStatus } from "../../apps/app-signature";
import {
	type InstallOrigin,
	type InstallProvenance,
	parseChannel,
	parseInstallOrigin,
} from "../../apps/install-provenance";
import type { SqliteDatabase } from "../sqlite";

export type AppRecord = {
	id: string;
	version: string;
	sdk: string;
	manifestPath: string;
	bundleDir: string;
	bundleSha256: string;
	installedAt: number;
	updatedAt: number;
	/** Advisory manifest-signature verification result recorded at install (13.2). */
	signatureStatus: AppSignatureStatus;
	/** Signer key id when the manifest carried a signature, else null. */
	signatureKeyId: string | null;
	/** Where this install came from + how it updates (doc 59 / schema v9). */
	origin: InstallOrigin;
	catalogId: string | null;
	channel: UpdateChannel;
	publisherKey: string | null;
	catalogVersion: string | null;
};

type DbRow = {
	id: string;
	version: string;
	sdk: string;
	manifest_path: string;
	bundle_dir: string;
	bundle_sha256: string;
	installed_at: number;
	updated_at: number;
	uninstalled_at: number | null;
	signature_status: string;
	signature_key_id: string | null;
	install_source: string;
	catalog_id: string | null;
	channel: string;
	publisher_key: string | null;
	catalog_version: string | null;
};

const APP_COLUMNS =
	"id, version, sdk, manifest_path, bundle_dir, bundle_sha256, installed_at, updated_at, uninstalled_at, signature_status, signature_key_id, install_source, catalog_id, channel, publisher_key, catalog_version";

/** Pull the provenance fields off an `AppRecord` (the shape repos write). */
export function recordProvenance(record: AppRecord): InstallProvenance {
	return {
		origin: record.origin,
		catalogId: record.catalogId,
		channel: record.channel,
		publisherKey: record.publisherKey,
		catalogVersion: record.catalogVersion,
	};
}

export class AppsRepository {
	constructor(private readonly db: SqliteDatabase) {}

	/**
	 * Insert a fresh app or reactivate a previously-uninstalled one. The
	 * caller has already verified no *active* row exists; this UPSERT handles
	 * the soft-deleted carry-over case.
	 */
	upsert(record: AppRecord): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO apps (id, version, sdk, manifest_path, bundle_dir, bundle_sha256, installed_at, updated_at, uninstalled_at, signature_status, signature_key_id, install_source, catalog_id, channel, publisher_key, catalog_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				record.id,
				record.version,
				record.sdk,
				record.manifestPath,
				record.bundleDir,
				record.bundleSha256,
				record.installedAt,
				record.updatedAt,
				record.signatureStatus,
				record.signatureKeyId,
				record.origin,
				record.catalogId,
				record.channel,
				record.publisherKey,
				record.catalogVersion,
			);
	}

	/** Bump the live row to a new version + bundle. Caller has already
	 *  confirmed an active row exists with a lower version. */
	updateBundle(record: AppRecord): void {
		this.db
			.prepare(
				"UPDATE apps SET version = ?, sdk = ?, manifest_path = ?, bundle_dir = ?, bundle_sha256 = ?, updated_at = ?, signature_status = ?, signature_key_id = ?, install_source = ?, catalog_id = ?, channel = ?, publisher_key = ?, catalog_version = ? WHERE id = ? AND uninstalled_at IS NULL",
			)
			.run(
				record.version,
				record.sdk,
				record.manifestPath,
				record.bundleDir,
				record.bundleSha256,
				record.updatedAt,
				record.signatureStatus,
				record.signatureKeyId,
				record.origin,
				record.catalogId,
				record.channel,
				record.publisherKey,
				record.catalogVersion,
				record.id,
			);
	}

	markUninstalled(id: string, at: number = Date.now()): boolean {
		const result = this.db
			.prepare("UPDATE apps SET uninstalled_at = ? WHERE id = ? AND uninstalled_at IS NULL")
			.run(at, id);
		return Number(result.changes) > 0;
	}

	/** Live (non-uninstalled) row, or null. */
	getActive(id: string): AppRecord | null {
		const row = this.db
			.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE id = ? AND uninstalled_at IS NULL`)
			.get(id) as DbRow | undefined;
		return row ? rowToRecord(row) : null;
	}

	listActive(): AppRecord[] {
		const rows = this.db
			.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE uninstalled_at IS NULL ORDER BY id`)
			.all() as DbRow[];
		return rows.map(rowToRecord);
	}
}

function rowToRecord(row: DbRow): AppRecord {
	return {
		id: row.id,
		version: row.version,
		sdk: row.sdk,
		manifestPath: row.manifest_path,
		bundleDir: row.bundle_dir,
		bundleSha256: row.bundle_sha256,
		installedAt: row.installed_at,
		updatedAt: row.updated_at,
		signatureStatus: parseSignatureStatus(row.signature_status),
		signatureKeyId: row.signature_key_id,
		origin: parseInstallOrigin(row.install_source),
		catalogId: row.catalog_id,
		channel: parseChannel(row.channel),
		publisherKey: row.publisher_key,
		catalogVersion: row.catalog_version,
	};
}

/** Map the stored string to the enum, defaulting unknown values to `Unsigned`
 *  (forward-compatible: a future status this build doesn't know reads as the
 *  benign default rather than throwing on a registry read). */
function parseSignatureStatus(value: string): AppSignatureStatus {
	switch (value) {
		case AppSignatureStatus.Verified:
			return AppSignatureStatus.Verified;
		case AppSignatureStatus.Untrusted:
			return AppSignatureStatus.Untrusted;
		case AppSignatureStatus.Invalid:
			return AppSignatureStatus.Invalid;
		default:
			return AppSignatureStatus.Unsigned;
	}
}

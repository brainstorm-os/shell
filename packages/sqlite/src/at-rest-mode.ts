/**
 * Stage 3b — boot-time at-rest probe + observability.
 *
 * The driver-availability gate inside `sqlite.ts` runs lazily on first
 * `open()`: it tries the SQLCipher driver, runs `sqlcipherContractHolds` and
 * either keeps it or falls back to plaintext. That's correct behaviour at
 * the storage layer, but it leaves the rest of the shell without a single
 * point that can answer "are we actually encrypted at rest right now?".
 *
 * This module is that point:
 *
 *   - `probeAtRestMode()` drives the full driver-resolution path against a
 *     throwaway `:memory:` DB and returns the resolved mode + the underlying
 *     driver name + a human reason. Called once at vault open / create; the
 *     result is cached for the rest of the process.
 *   - `AtRestMode` is the enum stamped into `vault.json` (per OQ-34 §Stage
 *     3b) so a returning open knows what the vault was *created with* and
 *     can fail closed if a future env regression silently downgrades the
 *     driver to plaintext.
 *   - `assertAtRestModeMatches` is the fail-closed comparator the open path
 *     calls; downgrades are loud, upgrades are recorded and continued.
 */

import { ensureDriverProbed, getDriverName, open as openSqlite } from "./sqlite";

export enum AtRestMode {
	/** The active SQLCipher driver resolved and its contract probe passed —
	 *  every DB this session opens against a real on-disk file is encrypted
	 *  under the HKDF-derived per-DB key. */
	Encrypted = "encrypted",
	/** No SQLCipher driver active (driver unavailable in this env OR the
	 *  contract probe failed). DB files are written in plaintext. */
	Plaintext = "plaintext",
}

export enum AtRestProbeReason {
	/** SQLCipher driver resolved and the contract probe held. */
	SqlcipherActive = "sqlcipher-active",
	/** SQLCipher driver unavailable under Bun (test runtime). */
	BunRuntime = "bun-runtime",
	/** SQLCipher driver package not installed / native addon missing /
	 *  contract probe failed. The driver fell back to `better-sqlite3`. */
	DriverUnavailable = "driver-unavailable",
}

export type AtRestProbeResult = {
	mode: AtRestMode;
	driverName: "sqlcipher" | "bun" | "node";
	reason: AtRestProbeReason;
};

let cached: AtRestProbeResult | null = null;
let probing: Promise<AtRestProbeResult> | null = null;

/**
 * Resolve the live at-rest mode. Drives the SQLCipher probe + the contract
 * check + the driver-resolution fallback by opening `:memory:` once; reads
 * the resolved driver name and maps it to a mode. Cached for the process.
 *
 * Concurrent callers share the in-flight promise so two-readers-at-boot
 * don't double-open the throwaway DB.
 */
export async function probeAtRestMode(): Promise<AtRestProbeResult> {
	if (cached) return cached;
	if (probing) return probing;
	probing = doProbe().then(
		(result) => {
			cached = result;
			probing = null;
			return result;
		},
		(error) => {
			probing = null;
			throw error;
		},
	);
	return probing;
}

async function doProbe(): Promise<AtRestProbeResult> {
	await ensureDriverProbed();
	// Materialise the driver by opening + immediately closing an in-memory
	// DB. `:memory:` skips the at-rest migration path entirely (sqlite.ts
	// guards it on `path !== ":memory:"`) but still runs `resolveDriver()`
	// which is what we need: that's where `sqlcipherContractHolds` fires
	// and decides between encrypted and the plaintext fallback.
	const db = await openSqlite(":memory:", { tunePragmas: false });
	try {
		db.close();
	} catch {
		/* defensive: closing an unkeyed :memory: should never throw, but
		 * we don't want the probe itself to fail the boot path. */
	}
	const driverName = getDriverName();
	if (driverName === "sqlcipher") {
		return {
			mode: AtRestMode.Encrypted,
			driverName,
			reason: AtRestProbeReason.SqlcipherActive,
		};
	}
	if (driverName === "bun") {
		return {
			mode: AtRestMode.Plaintext,
			driverName,
			reason: AtRestProbeReason.BunRuntime,
		};
	}
	return {
		mode: AtRestMode.Plaintext,
		driverName: driverName ?? "node",
		reason: AtRestProbeReason.DriverUnavailable,
	};
}

/**
 * Reset the cached probe result. Production never calls this; tests use it
 * for isolation alongside `__setSqlcipherDriverForTests`.
 */
export function __resetAtRestProbeForTests(): void {
	cached = null;
	probing = null;
}

/**
 * Human-readable one-liner suitable for a boot log. Lives next to the
 * probe so every caller logs the same wording.
 */
export function describeAtRestMode(result: AtRestProbeResult): string {
	if (result.mode === AtRestMode.Encrypted) {
		return "[brainstorm] storage: encrypted at rest (sqlcipher driver active)";
	}
	if (result.reason === AtRestProbeReason.BunRuntime) {
		return "[brainstorm] storage: UNENCRYPTED at rest (Bun test runtime — sqlcipher non-starter)";
	}
	return "[brainstorm] storage: UNENCRYPTED at rest (3b inactive — sqlcipher driver unavailable, OQ-34)";
}

/** Outcome of reconciling a recorded mode against a freshly-probed one. */
export enum AtRestReconcileOutcome {
	/** Recorded mode matches the probe — nothing to do. */
	Matches = "matches",
	/** Vault was created plaintext, environment is now encrypted-capable —
	 *  the next vault save stamps Encrypted; the storage layer migrates
	 *  every DB file on first open. */
	UpgradeReady = "upgrade-ready",
	/** Vault was created encrypted but the probe reports plaintext —
	 *  ALWAYS fail closed: a silent fall-through to plaintext would
	 *  read ciphertext as garbage / a missing-key open would silently
	 *  create a fresh plaintext file alongside the encrypted original
	 *  (data loss). The user's env regressed; we refuse to open. */
	DowngradeRefused = "downgrade-refused",
	/** No recorded mode (legacy vault pre-this-iteration). The next save
	 *  stamps whatever the probe says — non-fatal. */
	FirstStamp = "first-stamp",
}

export type AtRestReconcileResult = {
	outcome: AtRestReconcileOutcome;
	/** The mode the vault should be considered to be in *now*, after this
	 *  call. For Matches / UpgradeReady / FirstStamp this is the probe's
	 *  mode; DowngradeRefused throws before reaching this. */
	effectiveMode: AtRestMode;
};

/**
 * Reconcile a vault's recorded `atRestMode` (read from vault.json) against
 * the live probe. Pure — does no I/O. Throws on a refused downgrade with a
 * message naming the vault (caller threads `vaultLabel`).
 */
export function reconcileAtRestMode(
	recorded: AtRestMode | undefined,
	probed: AtRestProbeResult,
	vaultLabel: string,
): AtRestReconcileResult {
	if (recorded === undefined) {
		return { outcome: AtRestReconcileOutcome.FirstStamp, effectiveMode: probed.mode };
	}
	if (recorded === probed.mode) {
		return { outcome: AtRestReconcileOutcome.Matches, effectiveMode: probed.mode };
	}
	if (recorded === AtRestMode.Plaintext && probed.mode === AtRestMode.Encrypted) {
		return { outcome: AtRestReconcileOutcome.UpgradeReady, effectiveMode: AtRestMode.Encrypted };
	}
	// recorded === Encrypted && probed === Plaintext — the refused downgrade.
	throw new Error(
		`Vault ${vaultLabel} was created with at-rest encryption (vault.json atRestMode=encrypted), but the SQLCipher driver is not active in this environment (${probed.reason}). Refusing to open: a plaintext open against the encrypted database would either fail to read the existing data or silently create a parallel plaintext copy (data loss / leak). Restore the SQLCipher driver (rebuild the native addon for this Electron version) and retry.`,
	);
}

/** Guard: the literal stamped into vault.json's `atRestMode` field. Used
 *  by the JSON validator on read. */
export function isAtRestMode(value: unknown): value is AtRestMode {
	return value === AtRestMode.Encrypted || value === AtRestMode.Plaintext;
}

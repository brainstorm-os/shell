/**
 * Windows-tolerant temp-dir teardown for tests.
 *
 * The suites under `main/entities`, `main/vault` and `main/collab` follow a
 * `mkdtemp` → exercise a vault → `rm(dir, { recursive: true })` pattern. On
 * the Windows CI runners that final rm intermittently failed with
 * `EBUSY: resource busy or locked` whenever anything still held an open
 * handle inside the dir (historically: bun:sqlite "zombie" connections kept
 * alive by un-finalized prepared statements, plus `VaultSession.dispose()`
 * fire-and-forgetting its async YDoc store closes). Both leaks are fixed at
 * the source — sqlite's `wrapBun.close()` finalizes statements, and
 * `dispose()` returns a promise tests await — so this helper is the
 * *last-resort* guard: it retries a transient Windows-only failure a bounded
 * number of times and then WARNS (leaving the temp dir behind for the runner
 * to reap) instead of failing an otherwise-green suite on cleanup.
 *
 * Everywhere else (and for any other error code) it stays strict: the error
 * propagates, because on POSIX an rm failure is a real bug, never a
 * file-lock artifact.
 */

import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Error codes Windows surfaces while a handle inside the tree is still
 *  open (or a virus scanner / indexer briefly pins a file). */
const WIN_TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

const RETRIES = 5;
const RETRY_DELAY_MS = 200;

export async function removeTestDir(dir: string): Promise<void> {
	if (!dir) return;
	try {
		// `maxRetries`/`retryDelay` already give Node's rm its own bounded
		// EBUSY/EPERM retry loop on Windows; the catch below is the fallback
		// for handles that outlive even that window.
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		return;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "";
		if (process.platform !== "win32" || !WIN_TRANSIENT_CODES.has(code)) throw error;
	}
	for (let attempt = 1; attempt <= RETRIES; attempt++) {
		await delay(RETRY_DELAY_MS * attempt);
		try {
			await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (!WIN_TRANSIENT_CODES.has(code)) throw error;
		}
	}
	console.warn(
		`[test] removeTestDir: leaving temp dir behind after persistent Windows file lock: ${dir}`,
	);
}

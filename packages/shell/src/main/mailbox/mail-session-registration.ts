/**
 * VaultSession-open registration for configured mail accounts (Mailbox-2
 * residue): when a vault opens, every enabled `MailAccount/v1` gets an
 * initial sync and a periodic re-sync — mail keeps flowing with the Mailbox
 * window closed (doc 53: the whole point of the shell-side transport).
 *
 * Deliberately timer-chained (one pass schedules the next) rather than
 * `setInterval`: a slow pass never overlaps itself, and `stop()` (vault
 * switch / close) cancels cleanly between passes. Per-account errors are
 * logged and skipped — one broken account never starves its siblings, and
 * the loop never throws into the shell. All timers are injectable so the
 * schedule is unit-tested without waiting.
 */

import { MAIL_ACCOUNT_TYPE_URL } from "@brainstorm-os/sdk-types";

/** Matches the Gmail connector's `defaultSyncInterval` (900 s). */
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
/** Let the vault-open work (seeding, indexing) settle before the first pass. */
const DEFAULT_INITIAL_DELAY_MS = 15 * 1000;

export type MailSessionSyncDeps = {
	listEnabledAccountIds(): Promise<string[]>;
	syncAccount(accountRef: string): Promise<unknown>;
	intervalMs?: number;
	initialDelayMs?: number;
	schedule?: (fn: () => void, ms: number) => unknown;
	cancel?: (handle: unknown) => void;
	log?: (message: string) => void;
};

export type MailSessionSyncHandle = {
	stop(): void;
	/** One full pass over every enabled account (initial-delay skip for
	 *  tests / a future manual "sync all"). Never throws. */
	runNow(): Promise<void>;
};

/** The minimal repo surface the account listing needs. */
type RepoLike = {
	idsByTypes(types: readonly string[]): string[];
	get(id: string): { id: string; properties: Record<string, unknown> } | null;
};

export function listEnabledMailAccountIds(repo: RepoLike): string[] {
	const out: string[] = [];
	for (const id of repo.idsByTypes([MAIL_ACCOUNT_TYPE_URL])) {
		const row = repo.get(id);
		if (row && row.properties.enabled === true) out.push(id);
	}
	return out;
}

export function startMailSessionSync(deps: MailSessionSyncDeps): MailSessionSyncHandle {
	const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
	const initialDelayMs = deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
	const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
	const cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const log = deps.log ?? (() => {});

	let stopped = false;
	let passRunning = false;
	let timer: unknown = null;

	const runPass = async (): Promise<void> => {
		if (stopped || passRunning) return;
		passRunning = true;
		try {
			let ids: string[] = [];
			try {
				ids = await deps.listEnabledAccountIds();
			} catch (error) {
				log(`mail session sync: listing accounts failed: ${(error as Error).message}`);
				return;
			}
			for (const id of ids) {
				if (stopped) return;
				try {
					await deps.syncAccount(id);
				} catch (error) {
					log(`mail session sync: account ${id} failed: ${(error as Error).message}`);
				}
			}
		} finally {
			passRunning = false;
		}
	};

	const scheduleNext = (ms: number): void => {
		if (stopped) return;
		timer = schedule(() => {
			void runPass().finally(() => scheduleNext(intervalMs));
		}, ms);
	};

	scheduleNext(initialDelayMs);

	return {
		stop: () => {
			stopped = true;
			if (timer !== null) cancel(timer);
			timer = null;
		},
		runNow: () => runPass(),
	};
}

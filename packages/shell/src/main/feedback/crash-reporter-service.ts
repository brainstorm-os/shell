/**
 * Feedback-2 — crash-reporter service.
 *
 * Shell-only — **never registered with `Broker`**. Sandboxed apps never
 * reach it; the dashboard preload exposes a privileged channel set
 * (`crash-reporter-handlers.ts`) for the Privacy UI.
 *
 * Capture surface:
 *   - `process.on('uncaughtException')` — main-process JS crash.
 *   - `process.on('unhandledRejection')` — main-process unhandled
 *     promise rejection.
 *   - `webContents.on('render-process-gone')` — wired per webContents
 *     via the global `app.on('web-contents-created', …)` hook.
 *   - `webContents.on('unresponsive')` — useful signal; the renderer is
 *     hung but not crashed.
 *   - `electron.crashReporter.start({ uploadToServer: false })` — set up
 *     for native-process crashes; we don't actually upload Crashpad
 *     dumps in v1 (out of scope; tracked in 14.24a follow-up).
 *
 * Privacy invariant: when `crashReportingEnabled === false`, the hooks
 * still fire but only record a lightweight local counter — kind +
 * `capturedAt`. Full payload + stack + log excerpt enqueue only when
 * the opt-in is on. Future flips of the opt-in don't retroactively
 * upgrade lightweight records — those stay local.
 *
 * Submission: `submitPending()` pulls the queue, POSTs each via
 * `executeNetworkFetch` (same SSRF / proxy / per-app audit path as
 * every other shell egress, audit `appId` is the privileged
 * `__crash__` sentinel). 2xx → remove. 4xx → drop + log (the server
 * refused the schema; no point retrying). 5xx / transport → leave
 * for the next pass.
 */

import {
	type ExecuteOptions,
	NetworkFetchError,
	type NetworkFetchRequest,
	executeNetworkFetch,
} from "../network/network-service";
import { type CrashPayload, redactCrashPayload, validateCrashPayload } from "./crash-payload";
import type { CrashQueue } from "./crash-queue";
import type { FeedbackSettingsStore } from "./feedback-settings-store";

/** Privileged sentinel `appId` recorded against the audit log entry for
 *  every crash POST. Apps cannot spoof this — they never reach the
 *  service. Distinguished from real app ids by the double-underscore
 *  prefix per §Shell-mediated
 *  network broker. */
export const CRASH_AUDIT_APP_ID = "__crash__";

export const CRASH_POST_TIMEOUT_MS = 15_000;
export const CRASH_POST_SIZE_CAP_BYTES = 64 * 1024;

export type CrashSubmissionResult = {
	readonly submitted: number;
	readonly failed: number;
	readonly dropped: number;
};

export type LocalCrashCounter = {
	/** Increment-only count of crashes captured while opted-out. */
	readonly count: number;
	/** Most recent capture in opted-out mode. `null` if none. */
	readonly lastCapturedAt: number | null;
};

export type CrashReporterServiceOptions = {
	readonly queue: CrashQueue;
	readonly settingsStore: FeedbackSettingsStore;
	/** Vault path for the redactor — closure so a vault switch between
	 *  boot and submit is picked up. */
	readonly getVaultPath: () => string | null;
	/** Shell build sha — recorded into every payload's `clientVersion`. */
	readonly clientVersion: string;
	/** `process.platform` typically. */
	readonly clientPlatform: string;
	/** Read the in-memory recent-log buffer. */
	readonly readRecentLog: () => string;
	/** Mint a fresh request id (production wires `newRequestId`). */
	readonly newRequestId: () => string;
	/** Pure-async network broker. Production passes `executeNetworkFetch`. */
	readonly fetcher?: (
		request: NetworkFetchRequest,
		opts: ExecuteOptions,
	) => Promise<{
		readonly status: number;
		readonly headers: Readonly<Record<string, string>>;
		readonly body: Uint8Array;
		readonly finalUrl: string;
	}>;
	/** Pass-through for `executeNetworkFetch` options. Tests inject stubs. */
	readonly executeOptions?: ExecuteOptions;
	readonly now?: () => number;
	readonly getBootStartMs?: () => number;
	/** Dev/CI only (`BRAINSTORM_FEEDBACK_ALLOW_PRIVATE=1`) — see
	 *  `FeedbackServiceOptions.allowPrivateEndpoint`. */
	readonly allowPrivateEndpoint?: boolean;
};

export class CrashReporterService {
	private readonly queue: CrashQueue;
	private readonly settingsStore: FeedbackSettingsStore;
	private readonly getVaultPath: () => string | null;
	private readonly clientVersion: string;
	private readonly clientPlatform: string;
	private readonly readRecentLog: () => string;
	private readonly newRequestId: () => string;
	private readonly fetcher: CrashReporterServiceOptions["fetcher"];
	private readonly executeOptions: ExecuteOptions | undefined;
	private readonly now: () => number;
	private readonly bootStartMs: number;
	private readonly allowPrivateEndpoint: boolean;
	private localCounter: LocalCrashCounter = { count: 0, lastCapturedAt: null };

	constructor(options: CrashReporterServiceOptions) {
		this.queue = options.queue;
		this.settingsStore = options.settingsStore;
		this.getVaultPath = options.getVaultPath;
		this.clientVersion = options.clientVersion;
		this.clientPlatform = options.clientPlatform;
		this.readRecentLog = options.readRecentLog;
		this.newRequestId = options.newRequestId;
		this.fetcher = options.fetcher;
		this.executeOptions = options.executeOptions;
		this.now = options.now ?? Date.now;
		this.bootStartMs = options.getBootStartMs?.() ?? this.now();
		this.allowPrivateEndpoint = options.allowPrivateEndpoint ?? false;
	}

	/** Assemble a payload, redact, then enqueue (or count locally if the
	 *  user is opted out). Every hook in this module wraps a call to this
	 *  in try/catch so the reporter never crashes the reporter. */
	async capture(
		input: Omit<
			CrashPayload,
			| "clientVersion"
			| "clientPlatform"
			| "capturedAt"
			| "requestId"
			| "installationId"
			| "durationSinceBootMs"
			| "recentLogExcerpt"
		> & { readonly recentLogExcerpt?: string },
	): Promise<void> {
		const capturedAt = this.now();
		const settings = await this.settingsStore.load();
		if (!settings.crashReportingEnabled) {
			this.localCounter = {
				count: this.localCounter.count + 1,
				lastCapturedAt: capturedAt,
			};
			return;
		}
		const payload: CrashPayload = {
			...input,
			recentLogExcerpt: input.recentLogExcerpt ?? this.readRecentLog(),
			clientVersion: this.clientVersion,
			clientPlatform: this.clientPlatform,
			capturedAt,
			requestId: this.newRequestId(),
			installationId: settings.installationId,
			durationSinceBootMs: Math.max(0, capturedAt - this.bootStartMs),
		};
		const validated = validateCrashPayload(payload);
		if (!validated.ok) {
			console.warn(`[crash-reporter] dropping invalid payload: ${validated.detail}`);
			return;
		}
		const vaultPath = this.getVaultPath() ?? "";
		const redacted = redactCrashPayload(validated.payload, { vaultPath });
		await this.queue.enqueue(redacted);
	}

	/** Drain the queue, POSTing each entry. Records the attempt time on
	 *  the settings store so the Privacy UI can show "last attempt N ago".
	 *  Returns a summary of what happened. */
	async submitPending(): Promise<CrashSubmissionResult> {
		const settings = await this.settingsStore.load();
		await this.settingsStore.patch({ lastCrashSubmitAttemptMs: this.now() });
		if (!settings.crashReportingEnabled) {
			return { submitted: 0, failed: 0, dropped: 0 };
		}
		if (settings.endpoint === null || settings.endpoint.length === 0) {
			return { submitted: 0, failed: 0, dropped: 0 };
		}
		if (!this.fetcher || !this.executeOptions) {
			return { submitted: 0, failed: 0, dropped: 0 };
		}
		const pending = await this.queue.pending();
		let submitted = 0;
		let failed = 0;
		let dropped = 0;
		for (const payload of pending) {
			const wire: CrashPayload = { ...payload, submittedAt: this.now() };
			const body = new TextEncoder().encode(JSON.stringify(wire));
			try {
				const response = await this.fetcher(
					{
						appId: CRASH_AUDIT_APP_ID,
						url: settings.endpoint,
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Brainstorm-Installation-Id": payload.installationId,
							"X-Brainstorm-Crash-Kind": payload.kind,
						},
						body,
						sizeCapBytes: CRASH_POST_SIZE_CAP_BYTES,
						timeoutMs: CRASH_POST_TIMEOUT_MS,
						...(this.allowPrivateEndpoint ? { allowPrivate: true } : {}),
					},
					this.executeOptions,
				);
				if (response.status >= 200 && response.status < 300) {
					await this.queue.remove(payload.requestId);
					submitted++;
				} else if (response.status >= 400 && response.status < 500) {
					await this.queue.remove(payload.requestId);
					dropped++;
					console.warn(
						`[crash-reporter] server rejected ${payload.requestId} (${response.status}); dropping`,
					);
				} else {
					failed++;
				}
			} catch (error) {
				failed++;
				if (!(error instanceof NetworkFetchError)) {
					console.warn(
						`[crash-reporter] submit ${payload.requestId} threw: ${(error as Error).message}`,
					);
				}
			}
		}
		return { submitted, failed, dropped };
	}

	/** Snapshot of the local opted-out counter. Pure read. */
	getLocalCounter(): LocalCrashCounter {
		return this.localCounter;
	}

	/** Reset the local counter — used by "Clear all" when the user wants
	 *  a fresh slate. */
	resetLocalCounter(): void {
		this.localCounter = { count: 0, lastCapturedAt: null };
	}
}

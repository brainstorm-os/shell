/**
 * Feedback-1 — submission service.
 *
 * Shell-only — **never registered with `Broker`**. The dashboard
 * renderer reaches it through a dedicated privileged IPC channel
 * (`feedback-handlers.ts`); apps see nothing. Mirrors the shell-private
 * pattern from `credentials/` / `vault-network-settings-store`.
 *
 * Flow per doc-48 §Feedback / §Posture rules:
 *
 *   1. Opt-in gate — disabled → `OptInRequired`.
 *   2. Endpoint gate — null → `EndpointNotConfigured` (fail fast, no
 *      guessed URL).
 *   3. `validatePayload` — `InvalidPayload` with detail on shape error.
 *   4. `redactPayload(payload, { vaultPath })` — vault path collapses
 *      to `<vault>`, home prefixes to `<home>/`, credential key shapes
 *      to `<credential>`, email-shaped tokens to `<email>`. Recent-log
 *      excerpt truncated to 64 KiB tail.
 *   5. POST the redacted JSON via the shell's network broker
 *      (`executeNetworkFetch`) so the same proxy / SSRF / per-app audit
 *      rules apply. AppId on the request is the privileged
 *      `__feedback__` sentinel — never an app's identity — so the audit
 *      log records the path honestly without exposing a real `app`.
 *   6. Map HTTP responses: 2xx → `{ ok: true; requestId; serverReceivedAt }`,
 *      4xx → `Rejected`, 5xx → `ServerError` (caller-retryable),
 *      transport error → `NetworkError` (caller-retryable).
 *
 * No offline queue in this slice — doc-48 §Stage gating lists the
 * offline queue as part of the same Stage 14 deliverable, but the
 * minimum-viable cut ships the synchronous path first. The error
 * shape is already retryable; the queue lands in a follow-up.
 */

import {
	type ExecuteOptions,
	NetworkFetchError,
	NetworkFetchErrorKind,
	type NetworkFetchRequest,
	executeNetworkFetch,
} from "../network/network-service";
import { type FeedbackPayload, redactPayload, validatePayload } from "./feedback-payload";
import type { FeedbackSettingsStore } from "./feedback-settings-store";

/** Privileged sentinel `appId` recorded against the audit log entry for
 *  every feedback POST. Apps cannot spoof this — they never reach the
 *  service. The shell distinguishes it from real app ids by the
 *  double-underscore prefix per
 *  §Shell-mediated network broker. */
export const FEEDBACK_AUDIT_APP_ID = "__feedback__";

/** Time budget for a feedback POST. Generous (the admin panel might be
 *  on a slow link) but bounded so a hung endpoint doesn't pin the
 *  dialog forever. */
export const FEEDBACK_POST_TIMEOUT_MS = 15_000;
/** Cap on the response body the service will read. Server returns a JSON
 *  ack — 64 KiB is more than enough; pathological responses (HTML error
 *  page) get truncated rather than memory-bloating the shell. */
export const FEEDBACK_POST_SIZE_CAP_BYTES = 64 * 1024;

export enum FeedbackErrorKind {
	OptInRequired = "opt-in-required",
	EndpointNotConfigured = "endpoint-not-configured",
	InvalidPayload = "invalid-payload",
	Rejected = "rejected",
	ServerError = "server-error",
	NetworkError = "network-error",
}

export class FeedbackError extends Error {
	override readonly name = "FeedbackError";
	readonly kind: FeedbackErrorKind;
	readonly detail: string;
	constructor(kind: FeedbackErrorKind, detail: string) {
		super(`${kind}: ${detail}`);
		this.kind = kind;
		this.detail = detail;
	}
}

export type FeedbackSubmitResult = {
	readonly ok: true;
	readonly requestId: string;
	readonly serverReceivedAt: number;
};

export type FeedbackServiceOptions = {
	/** Pure-async network broker. Pass `executeNetworkFetch` in
	 *  production; tests inject a deterministic stub. */
	readonly fetcher: (
		request: NetworkFetchRequest,
		opts: ExecuteOptions,
	) => Promise<{
		readonly status: number;
		readonly headers: Readonly<Record<string, string>>;
		readonly body: Uint8Array;
		readonly finalUrl: string;
	}>;
	/** Pass-through for `executeNetworkFetch` opts. Production wires the
	 *  same `productionFetchImpl` + `productionLookupHost` + production
	 *  audit sink the network broker uses; tests inject stubs. */
	readonly executeOptions: ExecuteOptions;
	/** Opt-in / endpoint / installationId persisted store. */
	readonly settingsStore: FeedbackSettingsStore;
	/** Vault path for `redactPayload`. Read via a closure so the active
	 *  vault is picked up on every `submit` (the user might switch
	 *  vaults between opening the dialog and clicking Send). */
	readonly getVaultPath: () => string | null;
	readonly now?: () => number;
	/** Dev/CI only (`BRAINSTORM_FEEDBACK_ALLOW_PRIVATE=1`): sets Net-1b
	 *  `allowPrivate` on the endpoint POST so a localhost collector can
	 *  receive the loop end-to-end. The SSRF floor still applies; release
	 *  builds never set the env. */
	readonly allowPrivateEndpoint?: boolean;
};

export class FeedbackService {
	private readonly fetcher: FeedbackServiceOptions["fetcher"];
	private readonly executeOptions: ExecuteOptions;
	private readonly settingsStore: FeedbackSettingsStore;
	private readonly getVaultPath: () => string | null;
	private readonly now: () => number;
	private readonly allowPrivateEndpoint: boolean;

	constructor(options: FeedbackServiceOptions) {
		this.fetcher = options.fetcher;
		this.executeOptions = options.executeOptions;
		this.settingsStore = options.settingsStore;
		this.getVaultPath = options.getVaultPath;
		this.now = options.now ?? Date.now;
		this.allowPrivateEndpoint = options.allowPrivateEndpoint ?? false;
	}

	async submit(payload: FeedbackPayload): Promise<FeedbackSubmitResult> {
		const settings = await this.settingsStore.load();
		if (!settings.enabled) {
			throw new FeedbackError(FeedbackErrorKind.OptInRequired, "feedback is not enabled");
		}
		if (settings.endpoint === null || settings.endpoint.length === 0) {
			throw new FeedbackError(
				FeedbackErrorKind.EndpointNotConfigured,
				"feedback endpoint is not configured",
			);
		}

		const validation = validatePayload(payload);
		if (!validation.ok) {
			throw new FeedbackError(FeedbackErrorKind.InvalidPayload, validation.detail);
		}

		const vaultPath = this.getVaultPath() ?? "";
		const redacted = redactPayload(validation.payload, { vaultPath });

		const wire = {
			...redacted,
			installationId: settings.installationId,
		};
		const body = new TextEncoder().encode(JSON.stringify(wire));

		let response: {
			readonly status: number;
			readonly headers: Readonly<Record<string, string>>;
			readonly body: Uint8Array;
			readonly finalUrl: string;
		};
		try {
			response = await this.fetcher(
				{
					appId: FEEDBACK_AUDIT_APP_ID,
					url: settings.endpoint,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Brainstorm-Installation-Id": settings.installationId,
					},
					body,
					sizeCapBytes: FEEDBACK_POST_SIZE_CAP_BYTES,
					timeoutMs: FEEDBACK_POST_TIMEOUT_MS,
					...(this.allowPrivateEndpoint ? { allowPrivate: true } : {}),
				},
				this.executeOptions,
			);
		} catch (error) {
			if (error instanceof NetworkFetchError) {
				throw new FeedbackError(retryableErrorKind(error.kind), `network: ${error.message}`);
			}
			throw new FeedbackError(
				FeedbackErrorKind.NetworkError,
				error instanceof Error ? error.message : "network failure",
			);
		}

		if (response.status >= 200 && response.status < 300) {
			return {
				ok: true,
				requestId: redacted.requestId,
				serverReceivedAt: this.now(),
			};
		}
		if (response.status >= 400 && response.status < 500) {
			throw new FeedbackError(
				FeedbackErrorKind.Rejected,
				`server rejected request (status ${response.status})`,
			);
		}
		throw new FeedbackError(
			FeedbackErrorKind.ServerError,
			`server error (status ${response.status})`,
		);
	}

	async getSettings() {
		return await this.settingsStore.load();
	}

	async setEnabled(enabled: boolean) {
		return await this.settingsStore.patch({ enabled });
	}

	async setEndpoint(endpoint: string | null) {
		return await this.settingsStore.patch({ endpoint });
	}

	async setCrashReportingEnabled(crashReportingEnabled: boolean) {
		return await this.settingsStore.patch({ crashReportingEnabled });
	}
}

/** Expose `executeNetworkFetch` as the default fetcher so production can
 *  wire the service without re-implementing the request shape. */
export const defaultFeedbackFetcher: FeedbackServiceOptions["fetcher"] = executeNetworkFetch;

function retryableErrorKind(kind: NetworkFetchErrorKind): FeedbackErrorKind {
	switch (kind) {
		case NetworkFetchErrorKind.Timeout:
		case NetworkFetchErrorKind.DnsFailure:
		case NetworkFetchErrorKind.TransportError:
			return FeedbackErrorKind.NetworkError;
		case NetworkFetchErrorKind.SsrfRefused:
		case NetworkFetchErrorKind.SizeCap:
		case NetworkFetchErrorKind.TooManyRedirects:
			return FeedbackErrorKind.NetworkError;
		default:
			return FeedbackErrorKind.NetworkError;
	}
}

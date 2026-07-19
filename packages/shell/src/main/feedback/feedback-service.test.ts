import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ExecuteOptions,
	NetworkFetchError,
	NetworkFetchErrorKind,
	type NetworkFetchRequest,
} from "../network/network-service";
import { FeedbackKind, type FeedbackPayload, FeedbackSensitivity } from "./feedback-payload";
import {
	FEEDBACK_AUDIT_APP_ID,
	FeedbackError,
	FeedbackErrorKind,
	FeedbackService,
} from "./feedback-service";
import { FeedbackSettingsStore, feedbackSettingsPath } from "./feedback-settings-store";

type Recorded = {
	request: NetworkFetchRequest;
	opts: ExecuteOptions;
};

function makePayload(overrides: Partial<FeedbackPayload> = {}): FeedbackPayload {
	return {
		kind: FeedbackKind.Bug,
		title: "Crashed on save",
		body: "Repro at /Users/alice/Vault/Notes/x.md",
		sensitivity: FeedbackSensitivity.Anonymous,
		includeRecentLog: false,
		clientVersion: "abc1234",
		clientPlatform: "darwin",
		submittedAt: 1_700_000_000_000,
		requestId: "01H00000000000000000000000",
		...overrides,
	};
}

function makeExecOptions(): ExecuteOptions {
	return {
		fetchImpl: async () => ({
			status: 200,
			headers: {},
			body: (async function* () {})(),
		}),
		lookupHost: async () => ["1.2.3.4"],
		auditSink: async () => {},
	};
}

describe("FeedbackService", () => {
	let dir: string;
	let store: FeedbackSettingsStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "feedback-test-"));
		store = new FeedbackSettingsStore({
			path: feedbackSettingsPath(dir),
			now: () => 1_700_000_000_000,
			random: () => 0.5,
		});
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("rejects when opt-in is off", async () => {
		await store.load();
		const service = new FeedbackService({
			fetcher: async () => ({
				status: 200,
				headers: {},
				body: new Uint8Array(),
				finalUrl: "x",
			}),
			executeOptions: makeExecOptions(),
			settingsStore: store,
			getVaultPath: () => "/Users/alice/Vault",
		});
		await expect(service.submit(makePayload())).rejects.toMatchObject({
			name: "FeedbackError",
			kind: FeedbackErrorKind.OptInRequired,
		});
	});

	it("rejects when endpoint is null", async () => {
		await store.patch({ enabled: true });
		const service = new FeedbackService({
			fetcher: async () => ({
				status: 200,
				headers: {},
				body: new Uint8Array(),
				finalUrl: "x",
			}),
			executeOptions: makeExecOptions(),
			settingsStore: store,
			getVaultPath: () => "/Users/alice/Vault",
		});
		await expect(service.submit(makePayload())).rejects.toMatchObject({
			kind: FeedbackErrorKind.EndpointNotConfigured,
		});
	});

	it("rejects an invalid payload before any network IO", async () => {
		await store.patch({ enabled: true, endpoint: "https://admin.example/api/feedback" });
		let calls = 0;
		const service = new FeedbackService({
			fetcher: async () => {
				calls++;
				return { status: 200, headers: {}, body: new Uint8Array(), finalUrl: "x" };
			},
			executeOptions: makeExecOptions(),
			settingsStore: store,
			getVaultPath: () => "/Users/alice/Vault",
		});
		const bad = { ...makePayload(), kind: "invalid" } as unknown as FeedbackPayload;
		await expect(service.submit(bad)).rejects.toMatchObject({
			kind: FeedbackErrorKind.InvalidPayload,
		});
		expect(calls).toBe(0);
	});

	it("posts the redacted payload to the endpoint on opt-in", async () => {
		await store.patch({ enabled: true, endpoint: "https://admin.example/api/feedback" });
		const recorded: Recorded[] = [];
		const service = new FeedbackService({
			fetcher: async (req, opts) => {
				recorded.push({ request: req, opts });
				return {
					status: 200,
					headers: { "content-type": "application/json" },
					body: new TextEncoder().encode("{}"),
					finalUrl: req.url,
				};
			},
			executeOptions: makeExecOptions(),
			settingsStore: store,
			getVaultPath: () => "/Users/alice/Vault",
		});
		const result = await service.submit(makePayload());
		expect(result.ok).toBe(true);
		expect(result.requestId).toBe("01H00000000000000000000000");
		expect(recorded).toHaveLength(1);
		const r = recorded[0];
		expect(r).toBeDefined();
		const request = (r as Recorded).request;
		expect(request.appId).toBe(FEEDBACK_AUDIT_APP_ID);
		expect(request.method).toBe("POST");
		expect(request.url).toBe("https://admin.example/api/feedback");
		expect(request.headers).toMatchObject({ "Content-Type": "application/json" });
		expect(request.headers?.["X-Brainstorm-Installation-Id"]).toBeDefined();
		const bodyText = new TextDecoder().decode(request.body);
		const parsed = JSON.parse(bodyText);
		expect(parsed.kind).toBe("bug");
		expect(parsed.body).toContain("<vault>/Notes/x.md");
		expect(parsed.body).not.toContain("/Users/alice/Vault");
		expect(parsed.installationId).toBeDefined();
	});

	it("preserves the user-typed contactEmail under IdentityVoluntary in the POST body", async () => {
		await store.patch({ enabled: true, endpoint: "https://admin.example/api/feedback" });
		const recorded: Recorded[] = [];
		const service = new FeedbackService({
			fetcher: async (req) => {
				recorded.push({ request: req, opts: makeExecOptions() });
				return {
					status: 202,
					headers: {},
					body: new Uint8Array(),
					finalUrl: req.url,
				};
			},
			executeOptions: makeExecOptions(),
			settingsStore: store,
			getVaultPath: () => "",
		});
		await service.submit(
			makePayload({
				sensitivity: FeedbackSensitivity.IdentityVoluntary,
				contactEmail: "me@self.example",
			}),
		);
		const request = recorded[0]?.request;
		expect(request).toBeDefined();
		const parsed = JSON.parse(new TextDecoder().decode((request as NetworkFetchRequest).body));
		expect(parsed.contactEmail).toBe("me@self.example");
	});

	it("passes allowPrivate only when allowPrivateEndpoint is set (dev/CI localhost loop)", async () => {
		await store.patch({ enabled: true, endpoint: "https://admin.example/api/feedback" });
		const recorded: Recorded[] = [];
		const makeService = (allowPrivateEndpoint: boolean) =>
			new FeedbackService({
				fetcher: async (req) => {
					recorded.push({ request: req, opts: makeExecOptions() });
					return { status: 200, headers: {}, body: new Uint8Array(), finalUrl: req.url };
				},
				executeOptions: makeExecOptions(),
				settingsStore: store,
				getVaultPath: () => "",
				allowPrivateEndpoint,
			});
		await makeService(false).submit(makePayload());
		await makeService(true).submit(makePayload());
		expect(recorded[0]?.request.allowPrivate).toBeUndefined();
		expect(recorded[1]?.request.allowPrivate).toBe(true);
	});

	it("strips contactEmail under Anonymous even if the caller set it", async () => {
		await store.patch({ enabled: true, endpoint: "https://admin.example/api/feedback" });
		const recorded: Recorded[] = [];
		const service = new FeedbackService({
			fetcher: async (req) => {
				recorded.push({ request: req, opts: makeExecOptions() });
				return { status: 200, headers: {}, body: new Uint8Array(), finalUrl: req.url };
			},
			executeOptions: makeExecOptions(),
			settingsStore: store,
			getVaultPath: () => "",
		});
		await service.submit({
			...makePayload(),
			sensitivity: FeedbackSensitivity.Anonymous,
			contactEmail: "leaked@example.com",
		} as FeedbackPayload);
		const parsed = JSON.parse(
			new TextDecoder().decode((recorded[0]?.request as NetworkFetchRequest).body),
		);
		expect(parsed.contactEmail).toBeUndefined();
	});

	it("maps 4xx to Rejected", async () => {
		await store.patch({ enabled: true, endpoint: "https://admin.example/api/feedback" });
		const service = new FeedbackService({
			fetcher: async () => ({
				status: 400,
				headers: {},
				body: new Uint8Array(),
				finalUrl: "x",
			}),
			executeOptions: makeExecOptions(),
			settingsStore: store,
			getVaultPath: () => "",
		});
		await expect(service.submit(makePayload())).rejects.toMatchObject({
			kind: FeedbackErrorKind.Rejected,
		});
	});

	it("maps 5xx to ServerError (caller-retryable)", async () => {
		await store.patch({ enabled: true, endpoint: "https://admin.example/api/feedback" });
		const service = new FeedbackService({
			fetcher: async () => ({
				status: 503,
				headers: {},
				body: new Uint8Array(),
				finalUrl: "x",
			}),
			executeOptions: makeExecOptions(),
			settingsStore: store,
			getVaultPath: () => "",
		});
		await expect(service.submit(makePayload())).rejects.toMatchObject({
			kind: FeedbackErrorKind.ServerError,
		});
	});

	it("maps transport NetworkFetchError to NetworkError", async () => {
		await store.patch({ enabled: true, endpoint: "https://admin.example/api/feedback" });
		const service = new FeedbackService({
			fetcher: async () => {
				throw new NetworkFetchError(NetworkFetchErrorKind.TransportError, "TLS handshake failed");
			},
			executeOptions: makeExecOptions(),
			settingsStore: store,
			getVaultPath: () => "",
		});
		const error = await service.submit(makePayload()).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(FeedbackError);
		expect((error as FeedbackError).kind).toBe(FeedbackErrorKind.NetworkError);
	});

	it("maps timeout to NetworkError", async () => {
		await store.patch({ enabled: true, endpoint: "https://admin.example/api/feedback" });
		const service = new FeedbackService({
			fetcher: async () => {
				throw new NetworkFetchError(NetworkFetchErrorKind.Timeout, "timed out");
			},
			executeOptions: makeExecOptions(),
			settingsStore: store,
			getVaultPath: () => "",
		});
		await expect(service.submit(makePayload())).rejects.toMatchObject({
			kind: FeedbackErrorKind.NetworkError,
		});
	});

	it("getSettings exposes the underlying store", async () => {
		await store.patch({ enabled: true, endpoint: "https://admin.example/api/feedback" });
		const service = new FeedbackService({
			fetcher: async () => ({
				status: 200,
				headers: {},
				body: new Uint8Array(),
				finalUrl: "x",
			}),
			executeOptions: makeExecOptions(),
			settingsStore: store,
			getVaultPath: () => "",
		});
		const settings = await service.getSettings();
		expect(settings.enabled).toBe(true);
		expect(settings.endpoint).toBe("https://admin.example/api/feedback");
		expect(settings.installationId).toBeDefined();
	});

	it("setEnabled / setEndpoint persist via the store", async () => {
		const service = new FeedbackService({
			fetcher: async () => ({
				status: 200,
				headers: {},
				body: new Uint8Array(),
				finalUrl: "x",
			}),
			executeOptions: makeExecOptions(),
			settingsStore: store,
			getVaultPath: () => "",
		});
		await service.setEnabled(true);
		await service.setEndpoint("https://admin2.example/api/feedback");
		const settings = await service.getSettings();
		expect(settings.enabled).toBe(true);
		expect(settings.endpoint).toBe("https://admin2.example/api/feedback");
	});
});

describe("FeedbackSettingsStore — persistence", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "feedback-settings-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("seeds defaults on first read + persists installationId across loads", async () => {
		const a = new FeedbackSettingsStore({
			path: feedbackSettingsPath(dir),
			now: () => 1_700_000_000_000,
			random: () => 0.5,
		});
		const first = await a.load();
		expect(first.enabled).toBe(false);
		expect(first.endpoint).toBeNull();
		expect(first.installationId).toHaveLength(26);

		const b = new FeedbackSettingsStore({
			path: feedbackSettingsPath(dir),
		});
		const reloaded = await b.load();
		expect(reloaded.installationId).toBe(first.installationId);
	});

	it("seeds the build-time default endpoint when present", async () => {
		const store = new FeedbackSettingsStore({
			path: feedbackSettingsPath(dir),
			buildTimeDefaultEndpoint: "https://admin.default.example/api/feedback",
		});
		const settings = await store.load();
		expect(settings.endpoint).toBe("https://admin.default.example/api/feedback");
	});

	it("recovers from a corrupt file", async () => {
		const path = feedbackSettingsPath(dir);
		await (await import("node:fs/promises")).writeFile(path, "{not json", "utf8");
		const store = new FeedbackSettingsStore({ path });
		const settings = await store.load();
		expect(settings.enabled).toBe(false);
		expect(settings.installationId).toHaveLength(26);
	});

	it("patch persists subsequent reads", async () => {
		const store = new FeedbackSettingsStore({ path: feedbackSettingsPath(dir) });
		await store.load();
		await store.patch({ enabled: true, endpoint: "https://admin.example/api/feedback" });
		const reload = new FeedbackSettingsStore({ path: feedbackSettingsPath(dir) });
		const settings = await reload.load();
		expect(settings.enabled).toBe(true);
		expect(settings.endpoint).toBe("https://admin.example/api/feedback");
	});
});

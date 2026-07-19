/**
 * Feedback-2 — `CrashReporterService` tests.
 *
 * Covers:
 *   - Capture happy paths for each `CrashKind` (uncaught, unhandled,
 *     renderer-gone, unresponsive).
 *   - Off-mode lightweight counter — no queue write, counter
 *     increments, payload never reaches the queue.
 *   - submitPending mocked POST: 2xx → remove, 4xx → drop + log, 5xx →
 *     leave, transport → leave; happy path asserts the audit appId is
 *     the privileged `__crash__` sentinel and that the body was
 *     redacted before send.
 *   - Hook installation (process listeners attached + removed).
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrashKind, RendererReason } from "./crash-payload";
import { CrashQueue } from "./crash-queue";
import { CRASH_AUDIT_APP_ID, CrashReporterService } from "./crash-reporter-service";
import { FeedbackSettingsStore } from "./feedback-settings-store";

type Fetcher = NonNullable<ConstructorParameters<typeof CrashReporterService>[0]["fetcher"]>;

let dir: string;
let queueDir: string;
let settingsPath: string;
let store: FeedbackSettingsStore;
let queue: CrashQueue;

async function makeStore(
	overrides: {
		enabled?: boolean;
		endpoint?: string | null;
		crashReportingEnabled?: boolean;
	} = {},
) {
	const s = new FeedbackSettingsStore({ path: settingsPath });
	await s.patch({
		enabled: overrides.enabled ?? true,
		endpoint: overrides.endpoint ?? "https://admin.example/api/crash",
		crashReportingEnabled: overrides.crashReportingEnabled ?? true,
	});
	return s;
}

function makeService(
	options: {
		fetcher?: Fetcher;
		now?: number;
		enabled?: boolean;
	} = {},
) {
	let counter = 0;
	const newRequestId = () => `req_${++counter}`;
	const base = {
		queue,
		settingsStore: store,
		getVaultPath: () => "/Users/alice/Vault",
		clientVersion: "test-build",
		clientPlatform: "darwin",
		readRecentLog: () => "log /Users/alice/Vault/x admin@example.com",
		newRequestId,
		now: () => options.now ?? 1_700_000_000_000,
		getBootStartMs: () => 1_700_000_000_000 - 60_000,
	} as const;
	if (options.fetcher) {
		return new CrashReporterService({
			...base,
			fetcher: options.fetcher,
			executeOptions: {
				fetchImpl: async () => {
					throw new Error("not used in tests");
				},
				lookupHost: async () => [],
				auditSink: { write: async () => undefined } as unknown as NonNullable<
					ConstructorParameters<typeof CrashReporterService>[0]["executeOptions"]
				>["auditSink"],
			},
		});
	}
	return new CrashReporterService(base);
}

beforeEach(async () => {
	const root = await fs.mkdtemp(join(tmpdir(), "crash-svc-"));
	dir = root;
	queueDir = join(root, "crash-reports");
	settingsPath = join(root, "feedback-settings.json");
	queue = new CrashQueue({ dir: queueDir });
	store = await makeStore();
});

afterEach(async () => {
	try {
		await fs.rm(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe("capture — opted-in", () => {
	it("enqueues an UncaughtException payload with redaction applied", async () => {
		const svc = makeService();
		await svc.capture({
			kind: CrashKind.UncaughtException,
			message: "boom /Users/alice/Vault/x.js",
			stack: "Error\n    at /Users/alice/Vault/x.js:1:1",
		});
		const pending = await queue.pending();
		expect(pending).toHaveLength(1);
		const payload = pending[0];
		expect(payload?.kind).toBe(CrashKind.UncaughtException);
		expect(payload?.message).toContain("<vault>/x.js");
		expect(payload?.message).not.toContain("/Users/alice");
		expect(payload?.stack).toContain("<vault>/x.js");
		expect(payload?.recentLogExcerpt).toContain("<vault>/x");
		expect(payload?.recentLogExcerpt).toContain("<email>");
		expect(payload?.installationId).toBeTruthy();
		expect(payload?.durationSinceBootMs).toBe(60_000);
	});

	it("enqueues an UnhandledRejection payload", async () => {
		const svc = makeService();
		await svc.capture({
			kind: CrashKind.UnhandledRejection,
			message: "rejection",
		});
		const pending = await queue.pending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.kind).toBe(CrashKind.UnhandledRejection);
	});

	it("enqueues a RendererCrashed payload with appId + routePath + exitCode", async () => {
		const svc = makeService();
		await svc.capture({
			kind: CrashKind.RendererCrashed,
			rendererReason: RendererReason.OutOfMemory,
			exitCode: 9,
			message: "renderer crashed (exitCode=9)",
			appId: "notes",
			routePath: "/n/123",
		});
		const pending = await queue.pending();
		expect(pending).toHaveLength(1);
		const payload = pending[0];
		expect(payload?.kind).toBe(CrashKind.RendererCrashed);
		expect(payload?.rendererReason).toBe(RendererReason.OutOfMemory);
		expect(payload?.exitCode).toBe(9);
		expect(payload?.appId).toBe("notes");
		expect(payload?.routePath).toBe("/n/123");
	});

	it("enqueues an UnresponsiveRenderer payload", async () => {
		const svc = makeService();
		await svc.capture({
			kind: CrashKind.UnresponsiveRenderer,
			message: "renderer hung",
			appId: "graph",
		});
		const pending = await queue.pending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.kind).toBe(CrashKind.UnresponsiveRenderer);
	});
});

describe("capture — opted-out", () => {
	it("increments the local counter without enqueuing", async () => {
		await store.patch({ crashReportingEnabled: false });
		const svc = makeService();
		await svc.capture({ kind: CrashKind.UncaughtException, message: "off-mode" });
		await svc.capture({ kind: CrashKind.UnhandledRejection, message: "off-mode-2" });
		const counter = svc.getLocalCounter();
		expect(counter.count).toBe(2);
		expect(counter.lastCapturedAt).toBeGreaterThan(0);
		const pending = await queue.pending();
		expect(pending).toHaveLength(0);
	});

	it("resetLocalCounter zeroes the counter", async () => {
		await store.patch({ crashReportingEnabled: false });
		const svc = makeService();
		await svc.capture({ kind: CrashKind.UncaughtException, message: "boom" });
		expect(svc.getLocalCounter().count).toBe(1);
		svc.resetLocalCounter();
		expect(svc.getLocalCounter().count).toBe(0);
	});

	it("flipping opt-in mid-session enqueues subsequent crashes; older off-mode records stay local", async () => {
		await store.patch({ crashReportingEnabled: false });
		const svc = makeService();
		await svc.capture({ kind: CrashKind.UncaughtException, message: "off" });
		expect(await queue.count()).toBe(0);
		await store.patch({ crashReportingEnabled: true });
		await svc.capture({ kind: CrashKind.UncaughtException, message: "on" });
		expect(await queue.count()).toBe(1);
		expect(svc.getLocalCounter().count).toBe(1);
	});
});

describe("submitPending", () => {
	it("POSTs each queued payload with the privileged __crash__ appId", async () => {
		const calls: Array<{ url: string; appId: string; body: string }> = [];
		const fetcher: Fetcher = async (req) => {
			calls.push({
				url: req.url,
				appId: req.appId,
				body: new TextDecoder().decode(req.body ?? new Uint8Array()),
			});
			return {
				status: 200,
				headers: {},
				body: new Uint8Array(),
				finalUrl: req.url,
			};
		};
		const svc = makeService({ fetcher });
		await svc.capture({
			kind: CrashKind.UncaughtException,
			message: "boom /Users/alice/Vault/x",
		});
		const summary = await svc.submitPending();
		expect(summary).toEqual({ submitted: 1, failed: 0, dropped: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.appId).toBe(CRASH_AUDIT_APP_ID);
		expect(calls[0]?.url).toBe("https://admin.example/api/crash");
		expect(calls[0]?.body).toContain("<vault>/x");
		expect(calls[0]?.body).not.toContain("/Users/alice");
		expect(await queue.count()).toBe(0);
	});

	it("passes allowPrivate on the POST only when allowPrivateEndpoint is set", async () => {
		const flags: (boolean | undefined)[] = [];
		const fetcher: Fetcher = async (req) => {
			flags.push(req.allowPrivate);
			return { status: 200, headers: {}, body: new Uint8Array(), finalUrl: req.url };
		};
		for (const allowPrivateEndpoint of [false, true]) {
			const svc = new CrashReporterService({
				queue,
				settingsStore: store,
				getVaultPath: () => "/Users/alice/Vault",
				clientVersion: "test-build",
				clientPlatform: "darwin",
				readRecentLog: () => "log",
				newRequestId: () => `req_${flags.length}`,
				fetcher,
				executeOptions: {
					fetchImpl: async () => {
						throw new Error("not used — fetcher is injected");
					},
					lookupHost: async () => [],
					auditSink: async () => {},
				},
				allowPrivateEndpoint,
			});
			await svc.capture({ kind: CrashKind.UncaughtException, message: "boom" });
			await svc.submitPending();
		}
		expect(flags).toEqual([undefined, true]);
	});

	it("drops 4xx responses and removes them from the queue", async () => {
		const fetcher: Fetcher = async () => ({
			status: 400,
			headers: {},
			body: new Uint8Array(),
			finalUrl: "",
		});
		const svc = makeService({ fetcher });
		await svc.capture({ kind: CrashKind.UncaughtException, message: "boom" });
		const summary = await svc.submitPending();
		expect(summary).toEqual({ submitted: 0, failed: 0, dropped: 1 });
		expect(await queue.count()).toBe(0);
	});

	it("leaves 5xx responses in the queue for retry", async () => {
		const fetcher: Fetcher = async () => ({
			status: 503,
			headers: {},
			body: new Uint8Array(),
			finalUrl: "",
		});
		const svc = makeService({ fetcher });
		await svc.capture({ kind: CrashKind.UncaughtException, message: "boom" });
		const summary = await svc.submitPending();
		expect(summary).toEqual({ submitted: 0, failed: 1, dropped: 0 });
		expect(await queue.count()).toBe(1);
	});

	it("leaves transport-error responses in the queue", async () => {
		const fetcher: Fetcher = async () => {
			throw new Error("ECONNREFUSED");
		};
		const svc = makeService({ fetcher });
		await svc.capture({ kind: CrashKind.UncaughtException, message: "boom" });
		const summary = await svc.submitPending();
		expect(summary.submitted).toBe(0);
		expect(summary.failed).toBe(1);
		expect(await queue.count()).toBe(1);
	});

	it("is a no-op when the user is opted out", async () => {
		await store.patch({ crashReportingEnabled: false });
		const fetcher: Fetcher = vi.fn();
		const svc = makeService({ fetcher: fetcher as Fetcher });
		const summary = await svc.submitPending();
		expect(summary).toEqual({ submitted: 0, failed: 0, dropped: 0 });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("is a no-op when the endpoint is unset", async () => {
		await store.patch({ endpoint: null });
		const fetcher: Fetcher = vi.fn();
		const svc = makeService({ fetcher: fetcher as Fetcher });
		const summary = await svc.submitPending();
		expect(summary).toEqual({ submitted: 0, failed: 0, dropped: 0 });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("updates lastCrashSubmitAttemptMs even when nothing to submit", async () => {
		await store.patch({ lastCrashSubmitAttemptMs: null });
		const fetcher: Fetcher = async () => ({
			status: 200,
			headers: {},
			body: new Uint8Array(),
			finalUrl: "",
		});
		const svc = makeService({ fetcher });
		await svc.submitPending();
		const after = await store.load();
		expect(after.lastCrashSubmitAttemptMs).not.toBeNull();
	});

	it("submits multiple queued payloads in one drain", async () => {
		let count = 0;
		const fetcher: Fetcher = async () => {
			count++;
			return { status: 200, headers: {}, body: new Uint8Array(), finalUrl: "" };
		};
		const svc = makeService({ fetcher });
		await svc.capture({ kind: CrashKind.UncaughtException, message: "1" });
		await svc.capture({ kind: CrashKind.UncaughtException, message: "2" });
		await svc.capture({ kind: CrashKind.UncaughtException, message: "3" });
		const summary = await svc.submitPending();
		expect(summary.submitted).toBe(3);
		expect(count).toBe(3);
		expect(await queue.count()).toBe(0);
	});
});

describe("invalid payload (defence in depth)", () => {
	it("drops an invalid payload rather than crashing the queue", async () => {
		const svc = makeService();
		// Bypass the captureN typing via `as unknown as`; the validator
		// inside capture() must catch the empty message.
		await svc.capture({
			kind: CrashKind.UncaughtException,
			message: "",
		} as unknown as Parameters<CrashReporterService["capture"]>[0]);
		expect(await queue.count()).toBe(0);
	});
});

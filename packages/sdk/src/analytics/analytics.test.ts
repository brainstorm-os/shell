import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initAll = vi.fn(() => Promise.resolve());
const trackFn = vi.fn();
const identifyFn = vi.fn();

vi.mock("@amplitude/unified", () => ({
	initAll,
	track: trackFn,
	identify: identifyFn,
	Identify: class {
		props = new Map<string, string>();
		set(key: string, value: string) {
			this.props.set(key, value);
			return this;
		}
	},
}));

describe("initAnalytics", () => {
	beforeEach(() => {
		vi.resetModules();
		initAll.mockClear();
		trackFn.mockClear();
		identifyFn.mockClear();
	});

	afterEach(() => {
		// @ts-expect-error test cleanup
		delete globalThis.window;
	});

	it("initializes with anonymous deviceId, no userId, IP tracking off", async () => {
		globalThis.window = {
			brainstorm: {
				version: "0.4.2",
				platform: "darwin",
				analyticsDeviceId: "01INSTALLCONSTANTID0000001",
			},
			localStorage: {
				getItem: () => null,
				setItem: () => {},
			},
		} as unknown as Window & typeof globalThis;

		const { initAnalytics, track } = await import("./index");
		initAnalytics();
		initAnalytics();
		await vi.waitFor(() => expect(initAll).toHaveBeenCalledTimes(1));

		const [apiKey, options] = initAll.mock.calls[0] as [string, Record<string, unknown>];
		// Key stays module-private: present for init, never asserted as a public export.
		expect(typeof apiKey).toBe("string");
		expect(apiKey.length).toBeGreaterThan(0);
		expect(options).toMatchObject({
			serverZone: "EU",
			analytics: {
				autocapture: true,
				deviceId: "01INSTALLCONSTANTID0000001",
				identityStorage: "localStorage",
				trackingOptions: { ipAddress: false },
			},
			sessionReplay: { sampleRate: 1 },
		});
		// Never pass a userId through init.
		expect((options as { analytics?: { userId?: string } }).analytics?.userId).toBeUndefined();

		expect(identifyFn).toHaveBeenCalledTimes(1);
		expect(trackFn).toHaveBeenCalledWith(
			"Application Started",
			expect.objectContaining({
				surface: "shell",
				platform: "darwin",
				shell_version: "0.4.2",
			}),
		);

		track("Vault Opened", { vault_id: "vault-1", source: "welcome" });
		await vi.waitFor(() =>
			expect(trackFn).toHaveBeenCalledWith("Vault Opened", { source: "welcome" }),
		);
	});

	it("does not initialize on GA builds (1.0+)", async () => {
		globalThis.window = {
			brainstorm: { version: "1.0.0", platform: "darwin" },
		} as unknown as Window & typeof globalThis;

		const { initAnalytics, track } = await import("./index");
		initAnalytics();
		track("Vault Opened", { vault_id: "vault-1" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(initAll).not.toHaveBeenCalled();
		expect(trackFn).not.toHaveBeenCalled();
	});

	it("stamps app context when running inside an app renderer", async () => {
		globalThis.window = {
			brainstorm: {
				version: "0.4.2",
				platform: "win32",
				analyticsDeviceId: "01INSTALLCONSTANTID0000001",
				app: { id: "io.brainstorm.notes", version: "1.2.0", sdkVersion: "1" },
			},
		} as unknown as Window & typeof globalThis;

		const { initAnalytics } = await import("./index");
		initAnalytics();
		await vi.waitFor(() => expect(trackFn).toHaveBeenCalled());

		expect(trackFn).toHaveBeenCalledWith(
			"Application Started",
			expect.objectContaining({
				surface: "app",
				app_id: "io.brainstorm.notes",
				app_version: "1.2.0",
			}),
		);
	});
});

describe("resolveAnalyticsDeviceId", () => {
	afterEach(() => {
		// @ts-expect-error test cleanup
		delete globalThis.window;
	});

	it("prefers the bridge install id over localStorage", async () => {
		const { resolveAnalyticsDeviceId } = await import("./index");
		expect(
			resolveAnalyticsDeviceId({ analyticsDeviceId: "from-bridge" }),
		).toBe("from-bridge");
	});

	it("mints and persists a fallback id when the bridge has none", async () => {
		const store = new Map<string, string>();
		globalThis.window = {
			localStorage: {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, v: string) => {
					store.set(k, v);
				},
			},
			crypto: { randomUUID: () => "fallback-uuid-1" },
		} as unknown as Window & typeof globalThis;

		const { resolveAnalyticsDeviceId } = await import("./index");
		expect(resolveAnalyticsDeviceId({})).toBe("fallback-uuid-1");
		expect(resolveAnalyticsDeviceId(null)).toBe("fallback-uuid-1");
	});
});

describe("sanitizeEventProperties", () => {
	it("strips identity and key material", async () => {
		const { sanitizeEventProperties } = await import("./index");
		expect(
			sanitizeEventProperties({
				vault_id: "v1",
				userId: "u1",
				email: "a@b.c",
				apiKey: "secret",
				publicKey: "ed25519…",
				source: "launcher",
				count: 2,
			}),
		).toEqual({ source: "launcher", count: 2 });
	});
});

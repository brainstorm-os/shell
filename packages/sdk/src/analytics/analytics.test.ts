import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initAll = vi.fn();
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

	it("initializes Amplitude once with EU zone + autocapture + session replay", async () => {
		globalThis.window = {
			brainstorm: { version: "0.4.2", platform: "darwin" },
		} as unknown as Window & typeof globalThis;

		const { initAnalytics, track } = await import("./index");
		initAnalytics();
		initAnalytics();
		await vi.waitFor(() => expect(initAll).toHaveBeenCalledTimes(1));

		expect(initAll).toHaveBeenCalledWith("691a93081b9b1af38116b0655eb17bd9", {
			serverZone: "EU",
			analytics: { autocapture: true },
			sessionReplay: { sampleRate: 1 },
		});
		expect(identifyFn).toHaveBeenCalledTimes(1);
		expect(trackFn).toHaveBeenCalledWith("Application Started", expect.objectContaining({
			surface: "shell",
			platform: "darwin",
			shell_version: "0.4.2",
		}));

		track("Vault Opened", { vault_id: "vault-1" });
		await vi.waitFor(() =>
			expect(trackFn).toHaveBeenCalledWith("Vault Opened", { vault_id: "vault-1" }),
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
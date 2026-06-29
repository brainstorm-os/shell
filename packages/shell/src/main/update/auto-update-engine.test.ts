import { describe, expect, it, vi } from "vitest";
import { UpdateChannel, UpdateLifecycle } from "../../shared/update-wire-types";
import {
	AutoUpdateEngine,
	type AutoUpdaterHandlers,
	type ManagedAutoUpdater,
} from "./auto-update-engine";

/** A fake autoUpdater that records calls and lets the test fire the
 *  lifecycle callbacks the real electron-updater would. */
function makeFakeUpdater() {
	let handlers: AutoUpdaterHandlers | null = null;
	const calls = {
		setChannel: [] as UpdateChannel[],
		check: 0,
		download: 0,
		quitAndInstall: 0,
	};
	const updater: ManagedAutoUpdater = {
		setChannel: (channel) => {
			calls.setChannel.push(channel);
		},
		checkForUpdates: async () => {
			calls.check++;
		},
		downloadUpdate: async () => {
			calls.download++;
		},
		quitAndInstall: () => {
			calls.quitAndInstall++;
		},
		on: (h) => {
			handlers = h;
		},
	};
	return {
		updater,
		calls,
		fire: () => {
			if (handlers === null) throw new Error("handlers not registered");
			return handlers;
		},
	};
}

describe("AutoUpdateEngine", () => {
	it("is Unsupported (and inert) when not packaged", async () => {
		const fake = makeFakeUpdater();
		const engine = new AutoUpdateEngine({
			updater: fake.updater,
			getChannel: async () => UpdateChannel.Stable,
			supported: false,
		});
		expect(engine.getState().lifecycle).toBe(UpdateLifecycle.Unsupported);
		await engine.check();
		expect(fake.calls.check).toBe(0);
		expect(engine.getState().lifecycle).toBe(UpdateLifecycle.Unsupported);
	});

	it("starts Idle and sets the persisted channel on check", async () => {
		const fake = makeFakeUpdater();
		const engine = new AutoUpdateEngine({
			updater: fake.updater,
			getChannel: async () => UpdateChannel.Beta,
			supported: true,
		});
		expect(engine.getState().lifecycle).toBe(UpdateLifecycle.Idle);
		await engine.check();
		expect(fake.calls.setChannel).toEqual([UpdateChannel.Beta]);
		expect(fake.calls.check).toBe(1);
	});

	it("drives the full detect → download → install lifecycle and emits each transition", async () => {
		const fake = makeFakeUpdater();
		const states: UpdateLifecycle[] = [];
		const engine = new AutoUpdateEngine({
			updater: fake.updater,
			getChannel: async () => UpdateChannel.Stable,
			supported: true,
			onState: (s) => states.push(s.lifecycle),
		});

		await engine.check();
		fake.fire().onUpdateAvailable("1.2.0");
		expect(engine.getState()).toMatchObject({
			lifecycle: UpdateLifecycle.Available,
			version: "1.2.0",
		});

		await engine.download();
		expect(fake.calls.download).toBe(1);
		fake.fire().onDownloadProgress({
			percent: 42,
			transferred: 42,
			total: 100,
			bytesPerSecond: 10,
		});
		expect(engine.getState()).toMatchObject({
			lifecycle: UpdateLifecycle.Downloading,
			version: "1.2.0",
			progress: { percent: 42 },
		});

		fake.fire().onUpdateDownloaded("1.2.0");
		expect(engine.getState().lifecycle).toBe(UpdateLifecycle.Downloaded);

		engine.installNow();
		expect(fake.calls.quitAndInstall).toBe(1);

		expect(states).toContain(UpdateLifecycle.Checking);
		expect(states).toContain(UpdateLifecycle.Available);
		expect(states).toContain(UpdateLifecycle.Downloading);
		expect(states).toContain(UpdateLifecycle.Downloaded);
	});

	it("never installs unless a download has completed", () => {
		const fake = makeFakeUpdater();
		const engine = new AutoUpdateEngine({
			updater: fake.updater,
			getChannel: async () => UpdateChannel.Stable,
			supported: true,
		});
		engine.installNow();
		expect(fake.calls.quitAndInstall).toBe(0);
	});

	it("resolves a check failure to the Error state instead of throwing", async () => {
		const fake = makeFakeUpdater();
		fake.updater.checkForUpdates = () => Promise.reject(new Error("offline"));
		const engine = new AutoUpdateEngine({
			updater: fake.updater,
			getChannel: async () => UpdateChannel.Stable,
			supported: true,
		});
		const state = await engine.check();
		expect(state.lifecycle).toBe(UpdateLifecycle.Error);
		expect(state.error).toBe("offline");
	});

	it("surfaces an autoUpdater error event as the Error state", async () => {
		const fake = makeFakeUpdater();
		const engine = new AutoUpdateEngine({
			updater: fake.updater,
			getChannel: async () => UpdateChannel.Stable,
			supported: true,
		});
		await engine.check();
		fake.fire().onError("signature mismatch");
		expect(engine.getState()).toMatchObject({
			lifecycle: UpdateLifecycle.Error,
			error: "signature mismatch",
		});
	});
});

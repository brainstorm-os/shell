import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type VaultSession,
	closeActiveVaultSession,
	drainActiveVaultSession,
	followActiveVaultSession,
	onActiveVaultSessionReleasing,
	setActiveVaultSession,
} from "../vault/session";
import { bindSessionHistory } from "./history-wiring";
import type { VersionHistory } from "./version-history";

function fakeSession(id: string): VaultSession {
	return { vaultId: id, vaultPath: `/v/${id}`, dispose: async () => {} } as unknown as VaultSession;
}

function fakeHistory() {
	return { dispose: vi.fn(), flush: vi.fn(async () => {}) };
}

const hooks = { follow: followActiveVaultSession, onReleasing: onActiveVaultSessionReleasing };

describe("bindSessionHistory (10.16 boot ordering)", () => {
	afterEach(() => closeActiveVaultSession());

	it("starts history for a vault that was already active when it was wired (boot restore)", () => {
		const boot = fakeSession("boot");
		setActiveVaultSession(boot);
		const build = vi.fn(() => fakeHistory() as unknown as VersionHistory);
		const binding = bindSessionHistory(hooks, build);
		expect(build).toHaveBeenCalledWith(boot);
		expect(binding.current()).not.toBeNull();
		binding.dispose();
	});

	it("rebuilds on a switch and flushes the outgoing engine while its session is open", async () => {
		const engines: Array<ReturnType<typeof fakeHistory>> = [];
		const binding = bindSessionHistory(hooks, () => {
			const h = fakeHistory();
			engines.push(h);
			return h as unknown as VersionHistory;
		});
		expect(binding.current()).toBeNull();
		setActiveVaultSession(fakeSession("a"));
		await drainActiveVaultSession();
		expect(engines[0]?.flush).toHaveBeenCalledTimes(1);
		expect(engines[0]?.dispose).not.toHaveBeenCalled();
		setActiveVaultSession(fakeSession("b"));
		expect(engines[0]?.dispose).toHaveBeenCalled();
		expect(engines).toHaveLength(2);
		closeActiveVaultSession();
		expect(binding.current()).toBeNull();
		binding.dispose();
	});

	it("a drain that hangs is bounded", async () => {
		setActiveVaultSession(fakeSession("slow"));
		const off = onActiveVaultSessionReleasing(() => new Promise(() => {}));
		await expect(drainActiveVaultSession(10)).resolves.toBeUndefined();
		off();
	});
});

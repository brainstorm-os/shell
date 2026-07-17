import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrivacyMode } from "../network/privacy-config";
import { ProxyMode } from "../network/proxy-config";
import { removeTestDir } from "../test-support/remove-test-dir";
import {
	NETWORK_SETTINGS_FILENAME,
	networkSettingsPath,
	readVaultNetworkSettings,
	writeVaultNetworkSettings,
} from "./vault-network-settings-store";

describe("vault-network-settings-store", () => {
	let vaultDir: string;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-net-settings-"));
	});

	afterEach(async () => {
		await removeTestDir(vaultDir);
	});

	describe("read default-on-first-read", () => {
		it("returns the defaults for a fresh vault (privacy On for normal path)", async () => {
			const settings = await readVaultNetworkSettings(vaultDir);
			expect(settings.privacy.mode).toBe(PrivacyMode.On);
			expect(settings.proxyOverride).toBeNull();
		});

		it("persists the defaults on first read so a subsequent read parses cleanly", async () => {
			await readVaultNetworkSettings(vaultDir);
			const onDisk = await readFile(networkSettingsPath(vaultDir), "utf8");
			const parsed = JSON.parse(onDisk);
			expect(parsed).toMatchObject({
				privacy: { mode: PrivacyMode.On },
				proxyOverride: null,
			});
		});
	});

	describe("write + reload round-trip", () => {
		it("persists Off + proxy override and reloads byte-equivalent", async () => {
			await writeVaultNetworkSettings(vaultDir, {
				privacy: { mode: PrivacyMode.Off },
				proxyOverride: {
					mode: ProxyMode.Manual,
					httpsProxy: { host: "work.proxy", port: 3128 },
					noProxy: [".internal"],
				},
			});
			const loaded = await readVaultNetworkSettings(vaultDir);
			expect(loaded.privacy.mode).toBe(PrivacyMode.Off);
			expect(loaded.proxyOverride?.mode).toBe(ProxyMode.Manual);
		});

		it("persists Allowlist + reloads", async () => {
			await writeVaultNetworkSettings(vaultDir, {
				privacy: { mode: PrivacyMode.Allowlist, hosts: ["*.example.com", "github.com"] },
				proxyOverride: null,
			});
			const loaded = await readVaultNetworkSettings(vaultDir);
			if (loaded.privacy.mode !== PrivacyMode.Allowlist) {
				throw new Error("expected allowlist");
			}
			expect(loaded.privacy.hosts).toEqual(["*.example.com", "github.com"]);
		});
	});

	describe("corrupt / invalid file → defaults", () => {
		it("reverts to defaults when the JSON is malformed", async () => {
			const path = networkSettingsPath(vaultDir);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, "{ this is not json", "utf8");
			const settings = await readVaultNetworkSettings(vaultDir);
			expect(settings.privacy.mode).toBe(PrivacyMode.On);
		});

		it("reverts to defaults when the shape fails validation", async () => {
			const path = networkSettingsPath(vaultDir);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(
				path,
				JSON.stringify({ privacy: { mode: "weird" }, proxyOverride: null }),
				"utf8",
			);
			const settings = await readVaultNetworkSettings(vaultDir);
			expect(settings.privacy.mode).toBe(PrivacyMode.On);
		});

		it("reverts to defaults + reinitialises on disk so the next read is clean", async () => {
			const path = networkSettingsPath(vaultDir);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, "garbage", "utf8");
			await readVaultNetworkSettings(vaultDir);
			const onDisk = JSON.parse(await readFile(path, "utf8"));
			expect(onDisk.privacy.mode).toBe(PrivacyMode.On);
		});
	});

	it("filename + path helper expose the canonical name", () => {
		expect(NETWORK_SETTINGS_FILENAME).toBe("network-settings.json");
		expect(networkSettingsPath("/v/X")).toContain("network-settings.json");
		expect(networkSettingsPath("/v/X")).toContain("shell");
	});
});

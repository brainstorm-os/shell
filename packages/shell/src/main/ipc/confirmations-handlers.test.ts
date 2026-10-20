import { ConfirmKind, confirmSkipKey } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { RESERVED_APP_IDS } from "../apps/manifest";
import type { SettingsRepository } from "../storage/settings-repo";
import { SHELL_SETTINGS_NAMESPACE, makeConfirmationsApi } from "./confirmations-handlers";

function memoryRepo() {
	const rows = new Map<string, string>();
	const id = (app: string, key: string) => `${app}\u0000${key}`;
	const repo = {
		get: (app: string, key: string) => rows.get(id(app, key)) ?? null,
		set: (app: string, key: string, value: string) => {
			rows.set(id(app, key), value);
		},
		deleteKeyForAllApps: (key: string) => {
			let n = 0;
			for (const k of [...rows.keys()]) {
				if (k.endsWith(`\u0000${key}`)) {
					rows.delete(k);
					n += 1;
				}
			}
			return n;
		},
	};
	return { rows, repo: repo as unknown as SettingsRepository };
}

describe("confirmations api (6.15)", () => {
	it("stores the shell's skips under a namespace no app can install as", () => {
		expect(RESERVED_APP_IDS.has(SHELL_SETTINGS_NAMESPACE)).toBe(true);
	});

	it("remembers a reversible kind and lists it", async () => {
		const { repo } = memoryRepo();
		const api = makeConfirmationsApi(async () => repo);
		expect(await api.list()).toEqual([]);
		expect(await api.remember(ConfirmKind.MoveToBin)).toBe(true);
		expect(await api.list()).toEqual([ConfirmKind.MoveToBin]);
	});

	it("refuses to remember an irreversible or unknown kind", async () => {
		const { rows, repo } = memoryRepo();
		const api = makeConfirmationsApi(async () => repo);
		for (const kind of [ConfirmKind.EmptyBin, ConfirmKind.DeleteVault, "anything"]) {
			expect(await api.remember(kind)).toBe(false);
		}
		expect(rows.size).toBe(0);
	});

	it("reset clears the shell's and every app's skips", async () => {
		const { rows, repo } = memoryRepo();
		repo.set("io.brainstorm.contacts", confirmSkipKey(ConfirmKind.MoveToBin), "true");
		const api = makeConfirmationsApi(async () => repo);
		await api.remember(ConfirmKind.MoveToBin);
		expect(await api.reset()).toBe(2);
		expect(rows.size).toBe(0);
		expect(await api.list()).toEqual([]);
	});

	it("fails soft with no open vault", async () => {
		const api = makeConfirmationsApi(async () => null);
		expect(await api.list()).toEqual([]);
		expect(await api.remember(ConfirmKind.MoveToBin)).toBe(false);
		expect(await api.reset()).toBe(0);
	});
});

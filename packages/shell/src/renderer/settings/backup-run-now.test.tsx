// @vitest-environment jsdom
/**
 * IE-14 — "Run now" tracks its own request: the status only reports `running`
 * after the run, so without this the button stayed clickable mid-export and a
 * second click's late reply re-armed the spinner.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupFrequency } from "../../shared/backup-frequency";
import { BackupMigrationPanel } from "./backup-migration-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS = {
	frequency: BackupFrequency.Daily,
	folder: "/backups",
	retention: 7,
	lastBackupAt: null,
	lastError: null,
	nextDueAt: 0,
	running: false,
};

/** Any API the panel touches resolves to null unless overridden. */
function stubApi(overrides: Record<string, unknown>): unknown {
	const fallback = (): unknown => new Proxy(() => Promise.resolve(null), { get: () => fallback() });
	return new Proxy(overrides, {
		get: (target, key: string) => (key in target ? target[key] : fallback()),
	});
}

describe("Run now (IE-14)", () => {
	let host: HTMLDivElement;
	let root: Root;
	let release: () => void;
	let runNow: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		runNow = vi.fn(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ ...STATUS, lastBackupAt: 1 });
				}),
		);
		(window as unknown as { brainstorm: unknown }).brainstorm = stubApi({
			backup: stubApi({
				status: async () => STATUS,
				restorePoints: async () => [],
				runNow,
			}),
			properties: stubApi({ entityTypes: async () => [] }),
		});
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	it("is busy and unclickable while its request is in flight", async () => {
		await act(async () => root.render(<BackupMigrationPanel />));
		await act(async () => undefined);
		const button = () =>
			host.querySelector<HTMLButtonElement>('[data-testid="backup-migration-schedule-run"]');
		expect(button()?.disabled).toBe(false);
		await act(async () => button()?.click());
		expect(button()?.disabled).toBe(true);
		await act(async () => button()?.click());
		expect(runNow).toHaveBeenCalledTimes(1);
		await act(async () => release());
		expect(button()?.disabled).toBe(false);
	});
});

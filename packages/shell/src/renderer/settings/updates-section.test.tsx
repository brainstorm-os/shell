// @vitest-environment jsdom
/**
 * 13.6 — Settings → Updates panel. Drives the three resolved states
 * (Available / UpToDate / Unknown) + the channel switch + the Download
 * → open-intent dispatch through a stubbed `window.brainstorm`.
 */

import {
	BrainstormMenuProvider,
	CONTEXT_MENU_ID,
	type ContextMenuItem,
	closeContextMenu,
	getActiveMenuStore,
} from "@brainstorm/sdk/menus";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateAvailability, UpdateChannel, UpdateLifecycle } from "../../shared/update-wire-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Stub = {
	version: string;
	update: {
		getPrefs: Mock;
		check: Mock;
		setChannel: Mock;
		getState: Mock;
		checkAuto: Mock;
		download: Mock;
		installNow: Mock;
		onStateChange: Mock;
	};
	intents: { dispatch: Mock };
};

let stub: Stub;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	stub = {
		version: "0.9.0",
		update: {
			getPrefs: vi.fn().mockResolvedValue({ channel: UpdateChannel.Stable, lastCheckedAt: null }),
			check: vi.fn(),
			setChannel: vi.fn().mockResolvedValue({ channel: UpdateChannel.Beta, lastCheckedAt: null }),
			// Default to the unsupported (dev) state so these tests exercise the
			// 13.6 feed-download fallback path; the auto path is covered by the
			// AutoUpdateEngine unit tests.
			getState: vi.fn().mockResolvedValue({ lifecycle: UpdateLifecycle.Unsupported }),
			checkAuto: vi.fn(),
			download: vi.fn(),
			installNow: vi.fn(),
			onStateChange: vi.fn().mockReturnValue(() => {}),
		},
		intents: { dispatch: vi.fn().mockResolvedValue({ handled: true }) },
	};
	(window as unknown as { brainstorm: unknown }).brainstorm = stub;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => closeContextMenu());
	act(() => root.unmount());
	host.remove();
	(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
});

async function mount() {
	const { UpdatesSection } = await import("./updates-section");
	await act(async () => {
		root.render(
			<BrainstormMenuProvider>
				<UpdatesSection />
			</BrainstormMenuProvider>,
		);
	});
	// flush the getPrefs effect
	await act(async () => {
		await Promise.resolve();
	});
}

function findButton(label: string): HTMLButtonElement {
	const btn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
		b.textContent?.includes(label),
	);
	if (!btn) throw new Error(`button "${label}" not found`);
	return btn;
}

function channelTrigger(): HTMLButtonElement {
	const trigger = host.querySelector<HTMLButtonElement>(".bs-select");
	if (!trigger) throw new Error("channel select missing");
	return trigger;
}

/** Items of the open select popup — the shared select control routes through
 *  the fancy-menus store (see `@brainstorm/sdk/select-menu` tests). */
function openItems(menuLabel: string): ContextMenuItem[] {
	const store = getActiveMenuStore();
	const open = store?.getAll().find((m) => m.id === `${CONTEXT_MENU_ID}:${menuLabel}`);
	if (!open) throw new Error(`menu ${menuLabel} not open`);
	return (open.param.data as { items: ContextMenuItem[] }).items;
}

describe("UpdatesSection", () => {
	it("shows the current version and seeds the channel from prefs", async () => {
		await mount();
		expect(host.textContent).toContain("0.9.0");
		expect(channelTrigger().querySelector(".bs-select__value")?.textContent).toBe("Stable");
	});

	it("renders the Available state with a Download button that opens the URL", async () => {
		stub.update.check.mockResolvedValue({
			availability: UpdateAvailability.Available,
			channel: UpdateChannel.Stable,
			currentVersion: "0.9.0",
			latest: { version: "1.0.0", downloadUrl: "https://dl/1.0.0", notes: "Big release" },
			checkedAt: "2026-06-09T12:00:00.000Z",
		});
		await mount();
		await act(async () => {
			findButton("Check for updates").click();
			await Promise.resolve();
		});
		expect(host.textContent).toContain("1.0.0");
		expect(host.textContent).toContain("Big release");

		await act(async () => {
			findButton("Download").click();
			await Promise.resolve();
		});
		expect(stub.intents.dispatch).toHaveBeenCalledWith({
			verb: "open",
			payload: { url: "https://dl/1.0.0" },
		});
	});

	it("renders the UpToDate state with no Download button", async () => {
		stub.update.check.mockResolvedValue({
			availability: UpdateAvailability.UpToDate,
			channel: UpdateChannel.Stable,
			currentVersion: "0.9.0",
			checkedAt: "2026-06-09T12:00:00.000Z",
		});
		await mount();
		await act(async () => {
			findButton("Check for updates").click();
			await Promise.resolve();
		});
		expect(host.textContent).toContain("latest version");
		expect(() => findButton("Download")).toThrow();
	});

	it("renders the Unknown state on a failed check", async () => {
		stub.update.check.mockResolvedValue({
			availability: UpdateAvailability.Unknown,
			channel: UpdateChannel.Stable,
			currentVersion: "0.9.0",
			checkedAt: "2026-06-09T12:00:00.000Z",
		});
		await mount();
		await act(async () => {
			findButton("Check for updates").click();
			await Promise.resolve();
		});
		expect(host.textContent).toContain("Couldn't check");
	});

	it("persists a channel change and clears the stale result", async () => {
		stub.update.check.mockResolvedValue({
			availability: UpdateAvailability.UpToDate,
			channel: UpdateChannel.Stable,
			currentVersion: "0.9.0",
			checkedAt: "2026-06-09T12:00:00.000Z",
		});
		await mount();
		await act(async () => {
			findButton("Check for updates").click();
			await Promise.resolve();
		});
		expect(host.textContent).toContain("latest version");

		act(() => channelTrigger().click());
		const items = openItems("Release channel");
		expect(items.map((it) => it.label)).toEqual(["Stable", "Beta"]);
		await act(async () => {
			items[1]?.onSelect?.();
			await Promise.resolve();
		});
		expect(stub.update.setChannel).toHaveBeenCalledWith(UpdateChannel.Beta);
		expect(host.textContent).not.toContain("latest version");
	});
});

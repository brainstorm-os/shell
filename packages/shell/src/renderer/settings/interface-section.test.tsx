// @vitest-environment jsdom
/**
 * Interface section — toggle round-trip. Reproduces the dogfood report
 * "I can't click the interface checkboxes; they only reflect after I close and
 * reopen settings". Drives the real component against a mock
 * `window.brainstorm.dashboard` whose `setHeaderControlVisible` mutates state
 * and pushes a fresh snapshot through the same `on(...)` channel the main
 * process uses — i.e. the exact live-reactivity path — then asserts the painted
 * checkbox reflects the new state without a remount.
 */

import { DEFAULT_CHROME, HeaderControlId } from "@brainstorm-os/protocol/shell-prefs";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsHeaderActionsContext } from "./header-actions";
import { InterfaceSection } from "./interface-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (snap: unknown) => void;

function makeDashboardMock() {
	const chrome = {
		visibility: { ...DEFAULT_CHROME.visibility },
		clock: { ...DEFAULT_CHROME.clock },
	};
	let listener: Listener | null = null;
	const snap = () => ({
		chrome: { visibility: { ...chrome.visibility }, clock: { ...chrome.clock } },
	});
	const push = () => listener?.(snap());
	return {
		chrome,
		snapshot: vi.fn(() => Promise.resolve(snap())),
		on: vi.fn((l: Listener) => {
			listener = l;
			return () => {
				listener = null;
			};
		}),
		setHeaderControlVisible: vi.fn((id: HeaderControlId, visible: boolean) => {
			chrome.visibility[id] = visible;
			push();
			return Promise.resolve();
		}),
		setClockPrefs: vi.fn(() => Promise.resolve()),
		resetChrome: vi.fn(() => Promise.resolve()),
	};
}

describe("InterfaceSection — header-control toggle round-trip", () => {
	let host: HTMLDivElement;
	let root: Root;
	let dashboard: ReturnType<typeof makeDashboardMock>;

	beforeEach(async () => {
		dashboard = makeDashboardMock();
		(window as unknown as { brainstorm: unknown }).brainstorm = { dashboard, vaults: {} };
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root.render(
				<SettingsHeaderActionsContext.Provider value={() => {}}>
					<InterfaceSection />
				</SettingsHeaderActionsContext.Provider>,
			);
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
	});

	const clockInput = () =>
		document.querySelector(`input[aria-label="Clock"]`) as HTMLInputElement | null;

	it("clicking the hidden input flips the painted box live (no remount)", async () => {
		const input = clockInput();
		expect(input).not.toBeNull();
		const box = input?.parentElement?.querySelector(".checkbox__box");
		expect(box?.classList.contains("checkbox__box--checked")).toBe(true);

		await act(async () => {
			input?.click();
		});

		expect(dashboard.setHeaderControlVisible).toHaveBeenCalledWith(HeaderControlId.Clock, false);
		const boxAfter = clockInput()?.parentElement?.querySelector(".checkbox__box");
		expect(boxAfter?.classList.contains("checkbox__box--checked")).toBe(false);
	});

	it("clicking the row/label (what the user actually clicks) toggles exactly once", async () => {
		const input = clockInput();
		const label = input?.closest("label.setting-row") as HTMLElement;
		expect(label).not.toBeNull();

		await act(async () => {
			label.click();
		});

		// A label-forwarded click must produce exactly ONE write — a double fire
		// (label default action + a bubbled input click) would net to no change.
		expect(dashboard.setHeaderControlVisible).toHaveBeenCalledTimes(1);
		expect(dashboard.setHeaderControlVisible).toHaveBeenCalledWith(HeaderControlId.Clock, false);
		const boxAfter = clockInput()?.parentElement?.querySelector(".checkbox__box");
		expect(boxAfter?.classList.contains("checkbox__box--checked")).toBe(false);
	});

	it("flips the painted box immediately even if no snapshot push arrives", async () => {
		// Simulate a stale/un-restarted main: the write is accepted but no
		// snapshot is pushed back. The optimistic mirror must still flip the box.
		dashboard.setHeaderControlVisible.mockImplementationOnce(
			(id: HeaderControlId, visible: boolean) => {
				dashboard.chrome.visibility[id] = visible;
				return Promise.resolve();
			},
		);
		const box = clockInput()?.parentElement?.querySelector(".checkbox__box") as HTMLElement;
		expect(box.classList.contains("checkbox__box--checked")).toBe(true);

		await act(async () => {
			box.click();
		});

		const boxAfter = clockInput()?.parentElement?.querySelector(".checkbox__box");
		expect(boxAfter?.classList.contains("checkbox__box--checked")).toBe(false);
	});

	it("clicking the painted box toggles exactly once", async () => {
		const box = clockInput()?.parentElement?.querySelector(".checkbox__box") as HTMLElement;
		expect(box).not.toBeNull();

		await act(async () => {
			box.click();
		});

		expect(dashboard.setHeaderControlVisible).toHaveBeenCalledTimes(1);
		const boxAfter = clockInput()?.parentElement?.querySelector(".checkbox__box");
		expect(boxAfter?.classList.contains("checkbox__box--checked")).toBe(false);
	});
});

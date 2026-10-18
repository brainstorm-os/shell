// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupSection } from "./startup-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StartupSection — keep running in the background (7.16)", () => {
	let host: HTMLDivElement;
	let root: Root;

	function install(supported: boolean, keepRunning = false) {
		const setKeepRunning = vi.fn((next: boolean) =>
			Promise.resolve({ supported, keepRunning: next }),
		);
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			background: {
				getPrefs: () => Promise.resolve({ supported, keepRunning }),
				setKeepRunning,
			},
		};
		return setKeepRunning;
	}

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
	});

	const toggle = () =>
		host.querySelector<HTMLInputElement>('input[aria-label="Keep running in the background"]');

	it("is hidden where the platform keeps windowless apps alive anyway (macOS)", async () => {
		install(false);
		await act(async () => root.render(<StartupSection />));
		expect(toggle()).toBeNull();
	});

	it("is off by default and writes the choice", async () => {
		const setKeepRunning = install(true);
		await act(async () => root.render(<StartupSection />));
		expect(toggle()?.checked).toBe(false);
		await act(async () => toggle()?.click());
		expect(setKeepRunning).toHaveBeenCalledWith(true);
		expect(toggle()?.checked).toBe(true);
	});
});

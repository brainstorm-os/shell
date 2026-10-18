// @vitest-environment jsdom
import { DEFAULT_DISPLAY_PREFS } from "@brainstorm-os/protocol/shell-prefs";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisibilityPreferences } from "./visibility-preferences";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("VisibilityPreferences (12.18)", () => {
	let host: HTMLDivElement;
	let root: Root;
	const setDisplayPrefs = vi.fn(() => Promise.resolve());

	beforeEach(() => {
		setDisplayPrefs.mockClear();
		(window as unknown as { brainstorm: unknown }).brainstorm = { dashboard: { setDisplayPrefs } };
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
	});

	const input = (label: string) =>
		host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;

	it("renders the three preferences off by default (missing on a stale main)", () => {
		act(() => root.render(<VisibilityPreferences display={undefined} />));
		for (const label of ["Higher contrast", "Text cursor and selection", "Always show scrollbars"]) {
			expect(input(label)?.checked, label).toBe(false);
		}
	});

	it("reflects the snapshot and writes only the toggled preference", () => {
		act(() =>
			root.render(
				<VisibilityPreferences display={{ ...DEFAULT_DISPLAY_PREFS, alwaysShowScrollbars: true }} />,
			),
		);
		expect(input("Always show scrollbars")?.checked).toBe(true);
		act(() => input("Higher contrast")?.click());
		expect(setDisplayPrefs).toHaveBeenCalledWith({ higherContrast: true });
	});
});

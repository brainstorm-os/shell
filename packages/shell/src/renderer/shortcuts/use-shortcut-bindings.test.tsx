/**
 * @vitest-environment jsdom
 *
 * `useShortcutBindings` hook — verifies that the renderer-side state
 * tracks the main-process `shortcuts:list` / `shortcuts:bindings-changed`
 * round-trip and falls back to the seed map when no bridge is wired.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BindingSource, type ShortcutBindingRow } from "../../shortcut-binding-types";
import { buildShortcutBindingsForTests, useShortcutBindings } from "./use-shortcut-bindings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	// Clean up the mock bridge — every test installs its own.
	const w = window as { brainstorm?: unknown };
	// biome-ignore lint/performance/noDelete: remove the bridge entirely so the next test's presence checks see absence, not a `brainstorm: undefined` key
	delete w.brainstorm;
});

function Probe({ id }: { id: string }) {
	const b = useShortcutBindings();
	return <span data-test={b.chordFor(id) ?? "null"} />;
}

function getProbeValue(): string | null {
	return container.querySelector("span")?.getAttribute("data-test") ?? null;
}

describe("useShortcutBindings", () => {
	it("falls back to the renderer seed when no bridge is wired", async () => {
		await act(async () => {
			root.render(<Probe id="shell/cheatsheet" />);
		});
		expect(getProbeValue()).toBe("CmdOrCtrl+Shift+K");
	});

	it("reflects the main-process snapshot when the bridge resolves", async () => {
		let resolveList: (rows: ShortcutBindingRow[]) => void = () => {};
		const list = new Promise<ShortcutBindingRow[]>((r) => {
			resolveList = r;
		});
		const bridge = {
			list: vi.fn(() => list),
			onBindingsChanged: vi.fn(() => () => {}),
		};
		(window as { brainstorm?: unknown }).brainstorm = { shortcuts: bridge };

		await act(async () => {
			root.render(<Probe id="shell/cheatsheet" />);
		});
		// Pre-resolve fallback (seed).
		expect(getProbeValue()).toBe("CmdOrCtrl+Shift+K");

		await act(async () => {
			resolveList([
				{
					id: "shell/cheatsheet",
					layer: "shell",
					label: "Show shortcuts cheatsheet",
					chord: "Mod+Shift+K",
					defaultChord: "CmdOrCtrl+Shift+K",
					source: BindingSource.UserOverride,
				},
			]);
			await list;
		});
		expect(getProbeValue()).toBe("Mod+Shift+K");
	});

	it("re-fetches on bindings-changed", async () => {
		let savedListener: (() => void) | null = null;
		let nextSnapshot: ShortcutBindingRow[] = [
			{
				id: "shell/cheatsheet",
				layer: "shell",
				label: "X",
				chord: "Mod+K",
				defaultChord: "CmdOrCtrl+Shift+K",
				source: BindingSource.UserOverride,
			},
		];
		const bridge = {
			list: vi.fn(() => Promise.resolve(nextSnapshot)),
			onBindingsChanged: vi.fn((cb: () => void) => {
				savedListener = cb;
				return () => {
					savedListener = null;
				};
			}),
		};
		(window as { brainstorm?: unknown }).brainstorm = { shortcuts: bridge };

		await act(async () => {
			root.render(<Probe id="shell/cheatsheet" />);
		});
		await act(async () => {});
		expect(getProbeValue()).toBe("Mod+K");

		// Simulate a main-process push.
		nextSnapshot = [
			{
				id: "shell/cheatsheet",
				layer: "shell",
				label: "X",
				chord: "Mod+Alt+K",
				defaultChord: "CmdOrCtrl+Shift+K",
				source: BindingSource.UserOverride,
			},
		];
		await act(async () => {
			savedListener?.();
		});
		await act(async () => {});
		expect(getProbeValue()).toBe("Mod+Alt+K");
		expect(bridge.list).toHaveBeenCalledTimes(2);
	});
});

describe("buildShortcutBindingsForTests", () => {
	it("seeds a synthetic snapshot consumers can query without the bridge", () => {
		const b = buildShortcutBindingsForTests({
			"shell/launcher": "Mod+J",
			"shell/cheatsheet": "Mod+Shift+K",
		});
		expect(b.chordFor("shell/launcher")).toBe("Mod+J");
		expect(b.rowFor("shell/launcher")?.source).toBe(BindingSource.UserOverride);
		expect(b.rowFor("shell/launcher")?.defaultChord).toBe("CmdOrCtrl+K");
		// Unknown id falls back to the seed.
		expect(b.chordFor("editor/find")).toBe("CmdOrCtrl+F");
	});
});

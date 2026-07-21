/**
 * @vitest-environment jsdom
 *
 * `<EditableChord>` round-trip — Stage 6.10f.
 *
 * Capture mode → conflict detection → save / cancel / reset / clear.
 * The IPC bridge is mocked; we assert what the surface sends through it,
 * not the wire format (the wire is pinned by `shortcuts-handlers.test.ts`).
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	BindingSource,
	type ShortcutBindingRow,
} from "@brainstorm-os/protocol/shortcut-binding-types";
import { buildShortcutBindingsForTests } from "../shortcuts/use-shortcut-bindings";
import { EditableChord, findConflict } from "./editable-chord";

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
});

function fireKey(target: EventTarget, init: KeyboardEventInit & { key: string }): void {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
}

function actionButton(label: string): HTMLButtonElement | null {
	const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".button"));
	return buttons.find((b) => b.textContent?.trim() === label) ?? null;
}

const launcherRow: ShortcutBindingRow = {
	id: "shell/launcher",
	layer: "shell",
	label: "Open Launcher",
	chord: "CmdOrCtrl+K",
	defaultChord: "CmdOrCtrl+K",
	source: BindingSource.Default,
};

const overriddenLauncherRow: ShortcutBindingRow = {
	id: "shell/launcher",
	layer: "shell",
	label: "Open Launcher",
	chord: "Mod+J",
	defaultChord: "CmdOrCtrl+K",
	source: BindingSource.UserOverride,
};

const bindings = buildShortcutBindingsForTests({
	"shell/launcher": "CmdOrCtrl+K",
	"shell/settings": "CmdOrCtrl+,",
	"shell/bin": "CmdOrCtrl+Shift+B",
});

describe("findConflict — pure", () => {
	it("returns the colliding row when normalized forms match", () => {
		// Mod+Shift+B and CmdOrCtrl+Shift+B normalize identically.
		const conflict = findConflict("Mod+Shift+B", "shell/launcher", bindings);
		expect(conflict?.id).toBe("shell/bin");
	});

	it("returns null when no other row collides", () => {
		expect(findConflict("Mod+J", "shell/launcher", bindings)).toBeNull();
	});

	it("does not conflict with self (rebinding to current chord)", () => {
		expect(findConflict("CmdOrCtrl+K", "shell/launcher", bindings)).toBeNull();
	});

	it("returns null for an empty chord (still being captured)", () => {
		expect(findConflict("", "shell/launcher", bindings)).toBeNull();
	});
});

describe("<EditableChord> idle state", () => {
	it("renders the chord tokens + Edit affordance", () => {
		const onSet = vi.fn();
		const onReset = vi.fn();
		act(() => {
			root.render(
				<EditableChord
					row={launcherRow}
					bindings={bindings}
					onSetOverride={onSet}
					onReset={onReset}
					translatedLabel="Open launcher"
				/>,
			);
		});
		// Idle button is present + tokens render as kbd elements.
		expect(container.querySelector(".keyboard__chord-button")).not.toBeNull();
		expect(container.querySelectorAll(".keyboard__chord-button kbd").length).toBeGreaterThan(0);
		// No reset button on a default row.
		expect(actionButton("Reset")).toBeNull();
	});

	it("shows the Reset action + override dot when the row is overridden", () => {
		const onSet = vi.fn();
		const onReset = vi.fn();
		act(() => {
			root.render(
				<EditableChord
					row={overriddenLauncherRow}
					bindings={bindings}
					onSetOverride={onSet}
					onReset={onReset}
					translatedLabel="Open launcher"
				/>,
			);
		});
		expect(actionButton("Reset")).not.toBeNull();
		expect(container.querySelector(".keyboard__override-dot")).not.toBeNull();
		// Idle aria-label folds in the override badge text so screen readers
		// hear "Edit shortcut for X · Customized".
		const chordBtn = container.querySelector<HTMLButtonElement>(".keyboard__chord-button");
		expect(chordBtn?.getAttribute("aria-label") ?? "").toContain("Customized");
	});

	it("Reset calls onReset with the row id", async () => {
		const onSet = vi.fn();
		const onReset = vi.fn().mockResolvedValue({ ok: true });
		act(() => {
			root.render(
				<EditableChord
					row={overriddenLauncherRow}
					bindings={bindings}
					onSetOverride={onSet}
					onReset={onReset}
					translatedLabel="Open launcher"
				/>,
			);
		});
		const btn = actionButton("Reset");
		expect(btn).not.toBeNull();
		await act(async () => {
			btn?.click();
		});
		expect(onReset).toHaveBeenCalledWith("shell/launcher");
		expect(onSet).not.toHaveBeenCalled();
	});
});

describe("<EditableChord> capture mode", () => {
	it("entering capture mounts the capture target", () => {
		const onSet = vi.fn();
		const onReset = vi.fn();
		act(() => {
			root.render(
				<EditableChord
					row={launcherRow}
					bindings={bindings}
					onSetOverride={onSet}
					onReset={onReset}
					translatedLabel="Open launcher"
				/>,
			);
		});
		const editBtn = container.querySelector<HTMLButtonElement>(".keyboard__chord-button");
		act(() => {
			editBtn?.click();
		});
		expect(container.querySelector('[data-bs-capture-active="true"]')).not.toBeNull();
		// Cancel + Clear + Save — all shared `<Button>` primitives.
		expect(actionButton("Cancel")).not.toBeNull();
		expect(actionButton("Clear")).not.toBeNull();
		expect(actionButton("Save")).not.toBeNull();
	});

	it("captures Mod+J and stages it; Save fires onSetOverride with the Mod-tokenized chord", async () => {
		const onSet = vi.fn().mockResolvedValue({ ok: true });
		const onReset = vi.fn();
		// Pin platform → mac so metaKey maps to Mod.
		Object.defineProperty(globalThis, "navigator", {
			value: { platform: "MacIntel", userAgent: "" },
			configurable: true,
		});
		act(() => {
			root.render(
				<EditableChord
					row={launcherRow}
					bindings={bindings}
					onSetOverride={onSet}
					onReset={onReset}
					translatedLabel="Open launcher"
				/>,
			);
		});
		act(() => {
			container.querySelector<HTMLButtonElement>(".keyboard__chord-button")?.click();
		});
		const target = container.querySelector('[data-bs-capture-active="true"]') as HTMLElement;
		expect(target).not.toBeNull();
		await act(async () => {
			fireKey(target, { key: "j", code: "KeyJ", metaKey: true });
		});
		// Save button enabled now (chord changed + no conflict).
		const saveBtn = actionButton("Save");
		expect(saveBtn?.disabled).toBe(false);
		// Tokens reflect the captured chord.
		const tokenText = Array.from(
			container.querySelectorAll<HTMLElement>(".keyboard__key--capture"),
		).map((el) => el.textContent ?? "");
		// Mac platform pins; tokens are platform-formatted.
		expect(tokenText.length).toBeGreaterThan(0);

		await act(async () => {
			saveBtn?.click();
		});
		expect(onSet).toHaveBeenCalledWith("shell/launcher", "Mod+J");
	});

	it("surfaces a conflict and disables Save when the captured chord collides", async () => {
		const onSet = vi.fn().mockResolvedValue({ ok: true });
		const onReset = vi.fn();
		Object.defineProperty(globalThis, "navigator", {
			value: { platform: "MacIntel", userAgent: "" },
			configurable: true,
		});
		act(() => {
			root.render(
				<EditableChord
					row={launcherRow}
					bindings={bindings}
					onSetOverride={onSet}
					onReset={onReset}
					translatedLabel="Open launcher"
				/>,
			);
		});
		act(() => {
			container.querySelector<HTMLButtonElement>(".keyboard__chord-button")?.click();
		});
		const target = container.querySelector('[data-bs-capture-active="true"]') as HTMLElement;
		// Mod+Shift+B normalizes to the same chord as shell/bin's CmdOrCtrl+Shift+B.
		await act(async () => {
			fireKey(target, { key: "b", code: "KeyB", metaKey: true, shiftKey: true });
		});
		const saveBtn = actionButton("Save");
		expect(saveBtn?.disabled).toBe(true);
		// Conflict pill carries copy.
		const status = container.querySelector(".keyboard__capture-error");
		expect(status?.textContent ?? "").toMatch(/Already used/);
		// And the capture target picks up the conflict styling hook.
		expect(container.querySelector(".keyboard__capture-target--conflict")).not.toBeNull();
	});

	it("a bare-modifier press keeps the surface armed without staging", async () => {
		const onSet = vi.fn();
		const onReset = vi.fn();
		act(() => {
			root.render(
				<EditableChord
					row={launcherRow}
					bindings={bindings}
					onSetOverride={onSet}
					onReset={onReset}
					translatedLabel="Open launcher"
				/>,
			);
		});
		act(() => {
			container.querySelector<HTMLButtonElement>(".keyboard__chord-button")?.click();
		});
		const target = container.querySelector('[data-bs-capture-active="true"]') as HTMLElement;
		await act(async () => {
			fireKey(target, { key: "Shift", shiftKey: true });
		});
		const status = container.querySelector(".keyboard__capture-status");
		// "Add a non-modifier key to finish the chord" surfaces.
		expect(status?.textContent ?? "").toMatch(/Add a non-modifier key/);
		// Save still disabled — no chord staged.
		const saveBtn = actionButton("Save");
		expect(saveBtn?.disabled).toBe(true);
		expect(onSet).not.toHaveBeenCalled();
	});

	it("Escape exits capture without staging anything", async () => {
		const onSet = vi.fn();
		const onReset = vi.fn();
		act(() => {
			root.render(
				<EditableChord
					row={launcherRow}
					bindings={bindings}
					onSetOverride={onSet}
					onReset={onReset}
					translatedLabel="Open launcher"
				/>,
			);
		});
		act(() => {
			container.querySelector<HTMLButtonElement>(".keyboard__chord-button")?.click();
		});
		const target = container.querySelector('[data-bs-capture-active="true"]') as HTMLElement;
		await act(async () => {
			fireKey(target, { key: "Escape" });
		});
		// Surface returns to idle.
		expect(container.querySelector('[data-bs-capture-active="true"]')).toBeNull();
		expect(container.querySelector(".keyboard__chord-button")).not.toBeNull();
		expect(onSet).not.toHaveBeenCalled();
	});

	it("Clear sends a null chord override (action stays accessible via menus)", async () => {
		const onSet = vi.fn().mockResolvedValue({ ok: true });
		const onReset = vi.fn();
		act(() => {
			root.render(
				<EditableChord
					row={launcherRow}
					bindings={bindings}
					onSetOverride={onSet}
					onReset={onReset}
					translatedLabel="Open launcher"
				/>,
			);
		});
		act(() => {
			container.querySelector<HTMLButtonElement>(".keyboard__chord-button")?.click();
		});
		const clearBtn = actionButton("Clear");
		await act(async () => {
			clearBtn?.click();
		});
		expect(onSet).toHaveBeenCalledWith("shell/launcher", null);
	});

	it("Cancel returns to idle without firing the bridge", async () => {
		const onSet = vi.fn();
		const onReset = vi.fn();
		Object.defineProperty(globalThis, "navigator", {
			value: { platform: "MacIntel", userAgent: "" },
			configurable: true,
		});
		act(() => {
			root.render(
				<EditableChord
					row={launcherRow}
					bindings={bindings}
					onSetOverride={onSet}
					onReset={onReset}
					translatedLabel="Open launcher"
				/>,
			);
		});
		act(() => {
			container.querySelector<HTMLButtonElement>(".keyboard__chord-button")?.click();
		});
		const target = container.querySelector('[data-bs-capture-active="true"]') as HTMLElement;
		await act(async () => {
			fireKey(target, { key: "k", code: "KeyK", metaKey: true });
		});
		const cancelBtn = actionButton("Cancel");
		await act(async () => {
			cancelBtn?.click();
		});
		expect(container.querySelector('[data-bs-capture-active="true"]')).toBeNull();
		expect(onSet).not.toHaveBeenCalled();
	});
});

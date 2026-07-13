import type { Input, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

const fakeWindow = {
	show: vi.fn(),
	focus: vi.fn(),
	isDestroyed: () => false,
	isMinimized: () => false,
	restore: vi.fn(),
};

vi.mock("electron", () => ({
	BrowserWindow: {
		fromWebContents: () => fakeWindow,
	},
}));

import { ShortcutRegistry } from "../shortcuts/shortcut-registry";
import { chordMatchesInput, createShortcutSetup, matchShellShortcut } from "./shortcut-setup";

type BeforeInputListener = (event: { preventDefault: () => void }, input: Input) => void;

let nextWebContentsId = 1;

function fakeWebContents() {
	const sent: Array<{ channel: string; payload: unknown }> = [];
	let listener: BeforeInputListener | null = null;
	const wc = {
		id: nextWebContentsId++,
		isDestroyed: () => false,
		send: (channel: string, payload: unknown) => {
			sent.push({ channel, payload });
		},
		on: (event: string, fn: BeforeInputListener) => {
			if (event === "before-input-event") listener = fn;
		},
	};
	return {
		wc: wc as unknown as WebContents,
		sent,
		fire: (input: Partial<Input>) => {
			let prevented = false;
			const preventDefault = () => {
				prevented = true;
			};
			listener?.({ preventDefault }, makeInput(input));
			return prevented;
		},
	};
}

describe("createShortcutSetup", () => {
	it("attach binds a before-input-event listener that fires shell:action for matching chords", () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		try {
			const env = fakeWebContents();
			const setup = createShortcutSetup({ getDashboard: () => env.wc });
			setup.attach(env.wc);

			const prevented = env.fire({ key: "k", meta: true });
			expect(prevented).toBe(true);
			expect(env.sent).toEqual([{ channel: "shell:action", payload: { action: "launcher" } }]);
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
	});

	it("Cmd+Space routes the search alternate to the dashboard", () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		try {
			const env = fakeWebContents();
			const setup = createShortcutSetup({ getDashboard: () => env.wc });
			setup.attach(env.wc);

			// shell/search's Cmd+Space alternate — reaches us in tests; on a
			// stock Mac the OS input-source switcher usually intercepts first.
			const prevented = env.fire({ key: " ", meta: true });
			expect(prevented).toBe(true);
			expect(env.sent).toEqual([{ channel: "shell:action", payload: { action: "search" } }]);
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
	});

	it("does NOT fire when the chord is not pressed", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const env = fakeWebContents();
		const setup = createShortcutSetup({ getDashboard: () => env.wc });
		setup.attach(env.wc);
		env.fire({ key: "a" });
		env.fire({ key: " " }); // Space with no modifier
		expect(env.sent).toEqual([]);
	});

	it("does NOT call globalShortcut (the old buggy API)", () => {
		// The new implementation is pure focus-scoped delivery; this test
		// exists to keep us honest if anyone tries to reintroduce
		// globalShortcut.register.
		const env = fakeWebContents();
		const setup = createShortcutSetup({ getDashboard: () => env.wc });
		setup.attach(env.wc);
		expect(typeof setup.registerAll).toBe("function");
		// no-op
		setup.registerAll();
		setup.unregisterAll();
	});

	it("attach is idempotent — attaching the same webContents twice binds once", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const env = fakeWebContents();
		let bindCount = 0;
		(env.wc as unknown as { on: (event: string, fn: unknown) => unknown }).on = (event: string) => {
			if (event === "before-input-event") bindCount++;
			return env.wc;
		};
		const setup = createShortcutSetup({ getDashboard: () => env.wc });
		setup.attach(env.wc);
		setup.attach(env.wc);
		expect(bindCount).toBe(1);
	});

	it("appearance.toggle chord routes the action to the dashboard", () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		try {
			const env = fakeWebContents();
			const setup = createShortcutSetup({ getDashboard: () => env.wc });
			setup.attach(env.wc);

			// Cmd+Shift+L — Electron reports `input.key` as "L" (uppercase) when
			// Shift is held on a US layout. Confirm the chord normalizer + the
			// before-input-event listener produce the expected `appearance.toggle`
			// payload so the dashboard's switch can hit the case.
			const prevented = env.fire({ key: "L", meta: true, shift: true });
			expect(prevented).toBe(true);
			expect(env.sent).toEqual([
				{ channel: "shell:action", payload: { action: "appearance.toggle" } },
			]);
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
	});

	it("silent shell actions (surfacesOnDashboard:false) dispatch without focusing the dashboard", () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		fakeWindow.show.mockClear();
		fakeWindow.focus.mockClear();
		try {
			const app = fakeWebContents();
			const dashboard = fakeWebContents();
			const setup = createShortcutSetup({ getDashboard: () => dashboard.wc });
			setup.attach(app.wc);

			// Cmd+Shift+L fired from the app window — appearance.toggle is
			// declared `surfacesOnDashboard:false`, so the dashboard window
			// must NOT be shown/focused even though the action still
			// dispatches through it.
			const prevented = app.fire({ key: "L", meta: true, shift: true });
			expect(prevented).toBe(true);
			expect(dashboard.sent).toEqual([
				{ channel: "shell:action", payload: { action: "appearance.toggle" } },
			]);
			expect(fakeWindow.show).not.toHaveBeenCalled();
			expect(fakeWindow.focus).not.toHaveBeenCalled();
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
	});

	it("surfacing shell actions (default) focus the dashboard when fired from an app window", () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		fakeWindow.show.mockClear();
		fakeWindow.focus.mockClear();
		try {
			const app = fakeWebContents();
			const dashboard = fakeWebContents();
			const setup = createShortcutSetup({ getDashboard: () => dashboard.wc });
			setup.attach(app.wc);

			// shell/launcher opens an overlay on the dashboard → must surface.
			const prevented = app.fire({ key: " ", meta: true });
			expect(prevented).toBe(true);
			expect(fakeWindow.show).toHaveBeenCalledTimes(1);
			expect(fakeWindow.focus).toHaveBeenCalledTimes(1);
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
	});

	it("Ctrl+Tab opens the switcher when ≥2 windows are open", () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		try {
			const env = fakeWebContents();
			const setup = createShortcutSetup({ getDashboard: () => env.wc, getWindowCount: () => 3 });
			setup.attach(env.wc);
			const prevented = env.fire({ key: "Tab", code: "Tab", control: true });
			expect(prevented).toBe(true);
			expect(env.sent).toEqual([{ channel: "shell:action", payload: { action: "switch-window" } }]);
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
	});

	it("Ctrl+Shift+Tab routes the reverse switch-window action", () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		try {
			const env = fakeWebContents();
			const setup = createShortcutSetup({ getDashboard: () => env.wc, getWindowCount: () => 2 });
			setup.attach(env.wc);
			const prevented = env.fire({ key: "Tab", code: "Tab", control: true, shift: true });
			expect(prevented).toBe(true);
			expect(env.sent).toEqual([
				{ channel: "shell:action", payload: { action: "switch-window-prev" } },
			]);
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
	});

	it("Ctrl+Tab falls through (no intercept) when fewer than 2 windows are open", () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		try {
			const env = fakeWebContents();
			const setup = createShortcutSetup({ getDashboard: () => env.wc, getWindowCount: () => 1 });
			setup.attach(env.wc);
			// With <2 windows the chord is left for the focused app (Browser /
			// Code Editor use Ctrl+Tab for their own tab cycling).
			const prevented = env.fire({ key: "Tab", code: "Tab", control: true });
			expect(prevented).toBe(false);
			expect(env.sent).toEqual([]);
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
	});

	it("releasing Ctrl commits the switcher (Alt+Tab release-to-commit)", () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		try {
			const env = fakeWebContents();
			const setup = createShortcutSetup({ getDashboard: () => env.wc, getWindowCount: () => 2 });
			setup.attach(env.wc);
			env.fire({ key: "Tab", code: "Tab", control: true }); // open
			const prevented = env.fire({ type: "keyUp", key: "Control" }); // release
			// keyUp of the modifier isn't preventDefault'd (we don't swallow it).
			expect(prevented).toBe(false);
			expect(env.sent).toEqual([
				{ channel: "shell:action", payload: { action: "switch-window" } },
				{ channel: "shell:action", payload: { action: "switch-window-commit" } },
			]);
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
	});

	it("releasing Ctrl with no open switcher does nothing", () => {
		const env = fakeWebContents();
		const setup = createShortcutSetup({ getDashboard: () => env.wc, getWindowCount: () => 2 });
		setup.attach(env.wc);
		env.fire({ type: "keyUp", key: "Control" });
		expect(env.sent).toEqual([]);
	});

	it("custom registry is honored without re-registering shell defaults", () => {
		const registry = new ShortcutRegistry();
		registry.registerShell([{ id: "shell/launcher", defaultChord: "Alt+L", label: "Open" }]);
		const setup = createShortcutSetup({
			registry,
			getDashboard: () => fakeWebContents().wc,
		});
		expect(setup.registry).toBe(registry);
		expect(matchShellShortcut(registry, makeInput({ key: "l", alt: true }))).toBe("shell/launcher");
	});
});

describe("chordMatchesInput", () => {
	it("CmdOrCtrl resolves to meta on darwin", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		expect(chordMatchesInput("CmdOrCtrl+Space", makeInput({ key: " ", meta: true }))).toBe(true);
		expect(chordMatchesInput("CmdOrCtrl+Space", makeInput({ key: " ", control: true }))).toBe(false);
	});

	it("CmdOrCtrl resolves to control elsewhere", () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		expect(chordMatchesInput("CmdOrCtrl+Space", makeInput({ key: " ", control: true }))).toBe(true);
		expect(chordMatchesInput("CmdOrCtrl+Space", makeInput({ key: " ", meta: true }))).toBe(false);
	});

	it("rejects when an unintended modifier is held", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		expect(
			chordMatchesInput("CmdOrCtrl+Space", makeInput({ key: " ", meta: true, shift: true })),
		).toBe(false);
	});

	// 6.10e — cross-layer single-key suppression. Single-key chords (no
	// modifier) are renderer-side only; main can't observe renderer focus
	// so it can't tell whether the user is typing into an input. Refuse
	// to deliver to avoid hijacking the keystroke.
	it("single-key chords are never deliverable from main (6.10e)", () => {
		expect(chordMatchesInput("?", makeInput({ key: "?" }))).toBe(false);
		expect(chordMatchesInput("/", makeInput({ key: "/" }))).toBe(false);
		expect(chordMatchesInput("Escape", makeInput({ key: "Escape" }))).toBe(false);
		expect(chordMatchesInput("Enter", makeInput({ key: "Enter" }))).toBe(false);
		expect(chordMatchesInput("ArrowDown", makeInput({ key: "ArrowDown" }))).toBe(false);
		expect(chordMatchesInput("Space", makeInput({ key: " " }))).toBe(false);
	});

	// 6.10a: layout-invariant matching. AZERTY / Cyrillic / Dvorak users
	// shouldn't have to rebind `Cmd+Shift+L` per layout — the physical key
	// position carries the chord. `KeyboardEvent.code` is layout-invariant
	// for ASCII letters and digits; `key` only is for semantic keys.
	it("ASCII-letter chord matches on input.code (layout-invariant)", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		// AZERTY: physical KeyL produces `,` as input.key (no Shift on AZERTY-fr
		// for that position). With Shift it produces `?`. Code stays `KeyL`.
		expect(
			chordMatchesInput(
				"CmdOrCtrl+Shift+L",
				makeInput({ key: "?", code: "KeyL", meta: true, shift: true }),
			),
		).toBe(true);
		// Cyrillic: physical KeyL produces `д`. Code stays `KeyL`.
		expect(
			chordMatchesInput(
				"CmdOrCtrl+Shift+L",
				makeInput({ key: "Д", code: "KeyL", meta: true, shift: true }),
			),
		).toBe(true);
	});

	it("ASCII-letter chord still matches on US layout (regression guard)", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		expect(
			chordMatchesInput(
				"CmdOrCtrl+Shift+L",
				makeInput({ key: "L", code: "KeyL", meta: true, shift: true }),
			),
		).toBe(true);
	});

	it("ASCII-letter chord rejects a different physical key even if input.key happens to match", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		// User remapped KeyA to produce "L" via OS-level layout. The chord
		// `Cmd+Shift+L` should reflect physical position, not remapped glyph.
		expect(
			chordMatchesInput(
				"CmdOrCtrl+Shift+L",
				makeInput({ key: "L", code: "KeyA", meta: true, shift: true }),
			),
		).toBe(false);
	});

	it("digit chords match on input.code (`Digit3`)", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		expect(
			chordMatchesInput("CmdOrCtrl+3", makeInput({ key: "3", code: "Digit3", meta: true })),
		).toBe(true);
		// AZERTY: `Shift+3` produces `#`; physical Digit3 + meta matches.
		expect(
			chordMatchesInput("CmdOrCtrl+3", makeInput({ key: "#", code: "Digit3", meta: true })),
		).toBe(true);
	});

	it("semantic keys still match on input.key when combined with a modifier", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		expect(chordMatchesInput("CmdOrCtrl+Space", makeInput({ key: " ", meta: true }))).toBe(true);
		expect(chordMatchesInput("CmdOrCtrl+Enter", makeInput({ key: "Enter", meta: true }))).toBe(true);
		expect(chordMatchesInput("Shift+Escape", makeInput({ key: "Escape", shift: true }))).toBe(true);
		expect(
			chordMatchesInput("CmdOrCtrl+ArrowDown", makeInput({ key: "ArrowDown", meta: true })),
		).toBe(true);
	});

	it("falls back to input.key when input.code is absent (older Electron / fakes)", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		expect(
			chordMatchesInput("CmdOrCtrl+Shift+L", makeInput({ key: "L", meta: true, shift: true })),
		).toBe(true);
	});
});

function makeInput(overrides: Partial<Input>): Input {
	return {
		type: "keyDown",
		key: "",
		code: "",
		shift: false,
		control: false,
		alt: false,
		meta: false,
		isAutoRepeat: false,
		isComposing: false,
		modifiers: [],
		...overrides,
	} as Input;
}

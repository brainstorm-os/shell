// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetShortcutSuppressionForTests,
	registerShortcutSuppression,
} from "../shortcut/suppression";
import { attachFindBar } from "./attach-find-bar";
import { FindBar } from "./find-bar";
import { type FindController, type FindControllerState, FindStatus } from "./find-controller";
import { FindPatternError } from "./find-pattern";
import { attachFindShortcuts } from "./shortcuts";

/** A controllable fake controller: settable state + spied actions, with
 *  a working subscribe/emit so the React/DOM twins re-render. */
function fakeController(initial?: Partial<FindControllerState>) {
	let state: FindControllerState = {
		open: true,
		term: "",
		options: { caseSensitive: false, wholeWord: false, regex: false, inSelection: false },
		matchCount: 0,
		activeIndex: -1,
		status: FindStatus.Empty,
		patternError: null,
		truncated: false,
		...initial,
	};
	const listeners = new Set<() => void>();
	const emit = () => {
		for (const l of listeners) l();
	};
	const spies = {
		setTerm: vi.fn(),
		setOptions: vi.fn(),
		next: vi.fn(),
		previous: vi.fn(),
		replace: vi.fn(),
		replaceAll: vi.fn(),
		open: vi.fn(),
		close: vi.fn(),
	};
	const controller: FindController = {
		getState: () => state,
		isOpen: () => state.open,
		subscribe: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		open: spies.open,
		close: spies.close,
		setTerm: spies.setTerm,
		setOptions: spies.setOptions,
		next: spies.next,
		previous: spies.previous,
		replace: spies.replace,
		replaceAll: spies.replaceAll,
		activeMatch: () => null,
	};
	return {
		controller,
		spies,
		set(patch: Partial<FindControllerState>) {
			state = { ...state, ...patch };
			emit();
		},
	};
}

describe("<FindBar>", () => {
	let host: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	const q = (sel: string) => host.querySelector<HTMLElement>(`[data-testid="${sel}"]`);

	// React 19 tracks the input value setter, so a plain `el.value = x`
	// + native `input` event doesn't trip `onChange`. Drive the change
	// through the prototype setter the way React's own test utils do.
	const type = (el: HTMLInputElement, value: string) => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		setter?.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	};

	it("renders nothing while closed", () => {
		const f = fakeController({ open: false });
		act(() => root.render(<FindBar controller={f.controller} />));
		expect(host.querySelector('[role="search"]')).toBeNull();
	});

	it("is a labelled search region with a live counter when open", () => {
		const f = fakeController({
			term: "cat",
			matchCount: 17,
			activeIndex: 2,
			status: FindStatus.Matches,
		});
		act(() => root.render(<FindBar controller={f.controller} />));
		const region = host.querySelector('[role="search"]');
		expect(region).not.toBeNull();
		const count = q("find-count");
		expect(count?.getAttribute("aria-live")).toBe("polite");
		expect(count?.textContent).toBe("3 of 17"); // activeIndex+1 of matchCount
		expect((q("find-term") as HTMLInputElement).value).toBe("cat");
	});

	it("shows the no-results label and disables stepping with 0 matches", () => {
		const f = fakeController({ term: "zz", status: FindStatus.NoMatches });
		act(() => root.render(<FindBar controller={f.controller} />));
		expect(q("find-count")?.textContent).toBe("No results");
		expect((q("find-next") as HTMLButtonElement).disabled).toBe(true);
		expect((q("find-prev") as HTMLButtonElement).disabled).toBe(true);
	});

	it("flags an invalid or unsafe regex on the input and the counter (B11.27)", () => {
		const f = fakeController({
			term: "(",
			status: FindStatus.InvalidPattern,
			patternError: FindPatternError.Invalid,
		});
		act(() => root.render(<FindBar controller={f.controller} />));
		expect(q("find-count")?.textContent).toBe("Invalid pattern");
		expect(q("find-term")?.getAttribute("aria-invalid")).toBe("true");
		act(() => f.set({ patternError: FindPatternError.Unsafe }));
		expect(q("find-count")?.textContent).toBe("Pattern too complex");
	});

	it("marks a truncated count with a trailing +", () => {
		const f = fakeController({
			term: "a",
			matchCount: 1000,
			activeIndex: 0,
			status: FindStatus.Matches,
			truncated: true,
		});
		act(() => root.render(<FindBar controller={f.controller} />));
		expect(q("find-count")?.textContent).toBe("1 of 1000+");
	});

	it("wires typing, stepping, options and close to the controller", () => {
		const f = fakeController({ matchCount: 3, status: FindStatus.Matches });
		act(() => root.render(<FindBar controller={f.controller} />));
		const term = q("find-term") as HTMLInputElement;
		act(() => type(term, "foo"));
		expect(f.spies.setTerm).toHaveBeenCalledWith("foo");
		act(() => q("find-next")?.click());
		expect(f.spies.next).toHaveBeenCalled();
		act(() => q("find-prev")?.click());
		expect(f.spies.previous).toHaveBeenCalled();
		act(() => q("find-opt-caseSensitive")?.click());
		expect(f.spies.setOptions).toHaveBeenCalledWith({ caseSensitive: true });
		act(() => q("find-close")?.click());
		expect(f.spies.close).toHaveBeenCalled();
		expect(q("find-opt-caseSensitive")?.getAttribute("aria-pressed")).toBe("false");
	});

	it("Enter / Shift+Enter / Escape on the term input step + close", () => {
		const f = fakeController({ matchCount: 2, status: FindStatus.Matches });
		act(() => root.render(<FindBar controller={f.controller} />));
		const term = q("find-term") as HTMLInputElement;
		act(() => term.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(f.spies.next).toHaveBeenCalled();
		act(() =>
			term.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
			),
		);
		expect(f.spies.previous).toHaveBeenCalled();
		act(() => term.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(f.spies.close).toHaveBeenCalled();
	});

	it("selects the retained term on (re)open so typing replaces it (F-214)", () => {
		const f = fakeController({
			open: false,
			term: "total",
			matchCount: 2,
			activeIndex: 0,
			status: FindStatus.Matches,
		});
		act(() => root.render(<FindBar controller={f.controller} />));
		act(() => f.set({ open: true }));
		const term = q("find-term") as HTMLInputElement;
		expect(document.activeElement).toBe(term);
		expect(term.value).toBe("total");
		expect(term.selectionStart).toBe(0);
		expect(term.selectionEnd).toBe("total".length);
	});

	it("hides the replace row in find mode, wires it in find-replace mode", () => {
		const f = fakeController({ matchCount: 1, status: FindStatus.Matches });
		act(() => root.render(<FindBar controller={f.controller} mode="find" />));
		expect(q("find-replace")).toBeNull();
		act(() => root.render(<FindBar controller={f.controller} mode="find-replace" />));
		const rin = q("find-replacement") as HTMLInputElement;
		act(() => type(rin, "bar"));
		act(() => q("find-replace")?.click());
		expect(f.spies.replace).toHaveBeenCalledWith("bar");
		act(() => q("find-replace-all")?.click());
		expect(f.spies.replaceAll).toHaveBeenCalledWith("bar");
	});
});

describe("attachFindBar (DOM twin)", () => {
	it("mounts on open, mirrors state, unmounts on close, disposer cleans up", () => {
		const host = document.createElement("div");
		const f = fakeController({ open: false });
		const dispose = attachFindBar(host, f.controller, { mode: "find-replace" });
		expect(host.querySelector('[role="search"]')).toBeNull(); // closed
		f.set({ open: true, term: "x", matchCount: 5, activeIndex: 0, status: FindStatus.Matches });
		expect(host.querySelector('[role="search"]')).not.toBeNull();
		expect(host.querySelector<HTMLElement>('[data-testid="find-count"]')?.textContent).toBe("1 of 5");
		host.querySelector<HTMLElement>('[data-testid="find-next"]')?.click();
		expect(f.spies.next).toHaveBeenCalled();
		f.set({ open: false });
		expect(host.querySelector('[role="search"]')).toBeNull(); // unmounted
		dispose();
		f.set({ open: true });
		expect(host.querySelector('[role="search"]')).toBeNull(); // unsubscribed
	});

	it("selects the retained term on reopen so typing replaces it (F-214)", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const f = fakeController({ open: false, term: "total" });
		const dispose = attachFindBar(host, f.controller);
		f.set({ open: true, matchCount: 2, activeIndex: 0, status: FindStatus.Matches });
		const term = host.querySelector<HTMLInputElement>('[data-testid="find-term"]');
		expect(term?.value).toBe("total");
		expect(document.activeElement).toBe(term);
		expect(term?.selectionStart).toBe(0);
		expect(term?.selectionEnd).toBe("total".length);
		dispose();
		host.remove();
	});
});

describe("attachFindShortcuts (global chords)", () => {
	const press = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
		window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...mods }));

	it("binds open / open-replace / next / previous / close; ignores bare Enter", () => {
		const c = { open: vi.fn(), next: vi.fn(), previous: vi.fn(), close: vi.fn() };
		const off = attachFindShortcuts(window, c);
		press("f", { ctrlKey: true });
		expect(c.open).toHaveBeenCalledWith("find");
		press("h", { ctrlKey: true });
		expect(c.open).toHaveBeenCalledWith("find-replace");
		press("g", { ctrlKey: true });
		expect(c.next).toHaveBeenCalled();
		press("g", { ctrlKey: true, shiftKey: true });
		expect(c.previous).toHaveBeenCalled();
		press("Escape");
		expect(c.close).toHaveBeenCalled();
		c.next.mockClear();
		press("Enter"); // bare Enter is input-local, never a global next
		expect(c.next).not.toHaveBeenCalled();
		// `open` is the spy for both Open + OpenReplace, so it's already
		// been called twice. The disposer must stop any further calls.
		const before = c.open.mock.calls.length;
		off();
		press("f", { ctrlKey: true });
		expect(c.open.mock.calls.length).toBe(before);
	});

	it("Close (Escape) does NOT preventDefault when controller.isOpen() returns false (regression — sibling Escape handlers must keep working)", () => {
		_resetShortcutSuppressionForTests();
		const c = {
			open: vi.fn(),
			next: vi.fn(),
			previous: vi.fn(),
			close: vi.fn(),
			isOpen: vi.fn(() => false),
		};
		const off = attachFindShortcuts(window, c);
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		window.dispatchEvent(event);
		// Sibling handlers see Escape unfettered when the bar isn't open.
		expect(event.defaultPrevented).toBe(false);
		expect(c.close).not.toHaveBeenCalled();
		off();
	});

	it("Close (Escape) DOES fire + preventDefault when controller.isOpen() returns true", () => {
		_resetShortcutSuppressionForTests();
		const c = {
			open: vi.fn(),
			next: vi.fn(),
			previous: vi.fn(),
			close: vi.fn(),
			isOpen: vi.fn(() => true),
		};
		const off = attachFindShortcuts(window, c);
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(c.close).toHaveBeenCalledTimes(1);
		off();
	});

	it("Close (Escape) fires even when a suppression source is active (regression)", () => {
		// Reproduces the bug: the controller registers a suppression source on
		// open(), so by the time Escape is pressed the global suppression check
		// returns true. Without `allowWhileSuppressed`, Escape is silently
		// dropped and the bar can never close from a keystroke.
		_resetShortcutSuppressionForTests();
		const unregister = registerShortcutSuppression(() => true);
		const c = { open: vi.fn(), next: vi.fn(), previous: vi.fn(), close: vi.fn() };
		const off = attachFindShortcuts(window, c);
		press("Escape");
		expect(c.close).toHaveBeenCalledTimes(1);
		off();
		unregister();
		_resetShortcutSuppressionForTests();
	});
});

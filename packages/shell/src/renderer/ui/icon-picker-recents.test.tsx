// @vitest-environment jsdom
import { IconKind } from "@brainstorm-os/sdk-types";
import { RECENT_ICONS_STORAGE_KEY } from "@brainstorm-os/sdk/icon-recents";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IconPicker } from "./icon-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("IconPicker (shell) — recent emoji and icons (8.11)", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		window.localStorage.removeItem(RECENT_ICONS_STORAGE_KEY);
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			icons: { list: () => Promise.resolve([]) },
		};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		window.localStorage.removeItem(RECENT_ICONS_STORAGE_KEY);
	});

	const mount = (onChange: (icon: unknown) => void = () => {}) =>
		act(() => root.render(<IconPicker value={null} onChange={onChange} onClose={() => {}} />));
	const recentRow = () => host.querySelector('[data-testid="icon-picker-recent"]');
	const selectTab = (label: string) => {
		const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find(
			(el) => el.textContent === label,
		);
		act(() => tab?.click());
	};

	it("has no Recent row on a first open", () => {
		mount();
		expect(recentRow()).toBeNull();
	});

	it("an emoji pick leads the Emoji tab next time", () => {
		const onChange = vi.fn();
		mount(onChange);
		const cell = host.querySelector<HTMLButtonElement>(".icon-picker__category .icon-picker__cell");
		act(() => cell?.click());
		const picked = onChange.mock.calls[0]?.[0] as { kind: IconKind; value: string };
		expect(picked.kind).toBe(IconKind.Emoji);
		act(() => root.render(<div />));
		mount();
		const recent = recentRow();
		expect(recent).not.toBeNull();
		expect(recent?.querySelectorAll(".icon-picker__cell")).toHaveLength(1);
	});

	it("an icon pick leads the Icons tab next time, and search hides the row", () => {
		const onChange = vi.fn();
		mount(onChange);
		selectTab("Icon");
		const cell = host.querySelector<HTMLButtonElement>(".icon-picker__cell");
		const name = cell?.getAttribute("aria-label");
		act(() => cell?.click());
		expect(onChange.mock.calls[0]?.[0]).toMatchObject({ kind: IconKind.Pack });
		act(() => root.render(<div />));
		mount();
		selectTab("Icon");
		expect(recentRow()?.querySelector(".icon-picker__cell")?.getAttribute("aria-label")).toBe(name);
	});
});

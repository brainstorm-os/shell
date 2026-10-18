// @vitest-environment jsdom
import { IconKind } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IconPicker } from "./picker";
import { RECENT_ICONS_STORAGE_KEY } from "./recent-icons";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout, so render the first few virtual rows unconditionally.
vi.mock("@tanstack/react-virtual", () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getVirtualItems: () =>
			Array.from({ length: Math.min(count, 4) }, (_, index) => ({
				index,
				key: index,
				start: index * 38,
				size: 38,
			})),
		getTotalSize: () => count * 38,
		scrollToIndex: () => undefined,
	}),
}));

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}

describe("IconPicker — recent emoji and icons (8.11)", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
		window.localStorage.removeItem(RECENT_ICONS_STORAGE_KEY);
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		window.localStorage.removeItem(RECENT_ICONS_STORAGE_KEY);
	});

	const headings = () =>
		[...host.querySelectorAll(".icon-picker__category-label")].map((el) => el.textContent);

	it("shows no Recent row until something has been picked", () => {
		act(() => root.render(<IconPicker value={null} onChange={() => {}} onClose={() => {}} />));
		expect(headings()).not.toContain("Recent");
	});

	it("records a pick and leads the Emoji tab with it next time", () => {
		const onChange = vi.fn();
		act(() => root.render(<IconPicker value={null} onChange={onChange} onClose={() => {}} />));
		const firstEmoji = host.querySelector<HTMLButtonElement>(".icon-picker__virtual-row button");
		expect(firstEmoji).not.toBeNull();
		const name = firstEmoji?.getAttribute("aria-label");
		act(() => firstEmoji?.click());
		const picked = onChange.mock.calls[0]?.[0] as { kind: IconKind; value: string };
		expect(picked.kind).toBe(IconKind.Emoji);

		act(() => root.render(<div />));
		act(() => root.render(<IconPicker value={null} onChange={() => {}} onClose={() => {}} />));
		expect(headings()[0]).toBe("Recent");
		const recentCell = host.querySelector<HTMLButtonElement>(".icon-picker__virtual-row button");
		expect(recentCell?.getAttribute("aria-label")).toBe(name);
	});
});

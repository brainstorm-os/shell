// @vitest-environment jsdom
/**
 * StartPage (POLISH-DSN-3) — tile grid from history, private-tab
 * suppression, and the click-through to `onOpen`.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryVisit } from "./logic/history";
import { StartPage } from "./start-page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

const VISITS: readonly HistoryVisit[] = [
	{ url: "https://docs.example.com/", title: "Docs", visitCount: 9, lastVisitedAt: 100 },
	{ url: "https://www.news.example.com/", title: "", visitCount: 3, lastVisitedAt: 200 },
];

describe("StartPage", () => {
	it("renders ranked tiles with title + host and opens on click", async () => {
		const onOpen = vi.fn();
		await act(async () => {
			root.render(<StartPage visits={VISITS} isPrivate={false} onOpen={onOpen} />);
		});
		const tiles = container.querySelectorAll<HTMLButtonElement>(".browser-start__tile");
		expect(tiles.length).toBe(2);
		expect(tiles[0]?.textContent).toContain("Docs");
		expect(tiles[0]?.textContent).toContain("docs.example.com");
		// Title-less visit falls back to its hostname label; `www.` stripped in
		// the host line.
		expect(tiles[1]?.textContent).toContain("news.example.com");
		await act(async () => tiles[0]?.click());
		expect(onOpen).toHaveBeenCalledWith("https://docs.example.com/");
	});

	it("a private tab suppresses history and shows the empty state", async () => {
		await act(async () => {
			root.render(<StartPage visits={VISITS} isPrivate={true} onOpen={vi.fn()} />);
		});
		expect(container.querySelector(".browser-start__tile")).toBeNull();
		expect(container.querySelector(".browser-start--empty")).not.toBeNull();
	});
});

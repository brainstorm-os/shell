// @vitest-environment jsdom
/**
 * 7.14 follow-up — the running-windows strip shows the SAME app badge chip
 * as the icon grid (shared `icon-badge.tsx` component + subscription, not a
 * fork). Drives the main→renderer `apps.onBadgesChanged` push and asserts
 * the chip on the matching running tile, the grid-mirroring aria labelling,
 * and clearing when the app drops out of the pushed set.
 */

import type { WindowEntry } from "@brainstorm-os/protocol/window-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WindowStrip } from "./window-strip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRIES = [
	{
		id: "w-mail",
		appId: "io.brainstorm.mailbox",
		appName: "Mailbox",
		windowId: "1",
		focused: true,
		state: "normal",
		title: "Inbox",
	},
	{
		id: "w-chat",
		appId: "io.brainstorm.chat",
		appName: "Chat",
		windowId: "1",
		focused: false,
		state: "normal",
		title: "",
	},
] as unknown as WindowEntry[];

type BadgeEntry = { appId: string } & ({ count: number } | { dot: true });

describe("WindowStrip — running-tile app badges (7.14)", () => {
	let host: HTMLDivElement;
	let root: Root;
	let emit: (entries: BadgeEntry[]) => void = () => undefined;

	const noop = () => undefined;

	beforeEach(() => {
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			apps: {
				onBadgesChanged: (listener: (entries: BadgeEntry[]) => void) => {
					emit = listener;
					return () => undefined;
				},
			},
		};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
	});

	async function mount(): Promise<void> {
		await act(async () => {
			root.render(
				<WindowStrip
					entries={ENTRIES}
					monitors={[]}
					onFocus={noop}
					onClose={noop}
					onMinimize={noop}
					onTile={noop}
					onMoveToMonitor={noop}
				/>,
			);
		});
	}

	const tiles = () => host.querySelectorAll<HTMLButtonElement>(".window-strip__tile");
	const chips = () => host.querySelectorAll<HTMLElement>(".dashboard-icons__badge");

	it("renders no chip until an app badges", async () => {
		await mount();
		expect(chips().length).toBe(0);
	});

	it("paints the shared chip on the matching tile and folds the count into its name", async () => {
		await mount();
		await act(async () => emit([{ appId: "io.brainstorm.chat", count: 4 }]));
		expect(chips().length).toBe(1);
		const chatTile = [...tiles()].find((el) => el.textContent?.includes("Chat"));
		const chip = chatTile?.querySelector<HTMLElement>(".dashboard-icons__badge");
		expect(chip?.textContent).toBe("4");
		expect(chip?.getAttribute("aria-hidden")).toBe("true");
		// Grid-mirroring aria: the badged tile's accessible name carries the count.
		expect(chatTile?.getAttribute("aria-label")).toContain("Chat");
		expect(chatTile?.getAttribute("aria-label")).toContain("4");
		// The unbadged tile keeps its app+title name.
		const mailTile = [...tiles()].find((el) => el.textContent?.includes("Mailbox"));
		expect(mailTile?.querySelector(".dashboard-icons__badge")).toBeNull();
		expect(mailTile?.getAttribute("aria-label")).toContain("Inbox");
	});

	it("caps the count at 99+ and renders a dot chip without a number", async () => {
		await mount();
		await act(async () =>
			emit([
				{ appId: "io.brainstorm.chat", count: 250 },
				{ appId: "io.brainstorm.mailbox", dot: true },
			]),
		);
		const dot = host.querySelector<HTMLElement>(".dashboard-icons__badge--dot");
		expect(dot).not.toBeNull();
		expect(dot?.textContent).toBe("");
		const countChips = [...chips()].filter(
			(c) => !c.classList.contains("dashboard-icons__badge--dot"),
		);
		expect(countChips.map((c) => c.textContent)).toEqual(["99+"]);
	});

	it("clears the chip when the app drops out of the pushed set", async () => {
		await mount();
		await act(async () => emit([{ appId: "io.brainstorm.chat", count: 2 }]));
		expect(chips().length).toBe(1);
		await act(async () => emit([]));
		expect(chips().length).toBe(0);
	});
});

// @vitest-environment jsdom
/**
 * 7.14 — app-icon notification badge rendering. Drives the main→renderer
 * `apps.onBadgesChanged` push and asserts the corner chip on the matching
 * app tile: a count (capped `99+`), a dot, and clearing when the app drops
 * out of the pushed set. The pure BadgeHost + ui-service are covered in
 * `badge-host.test` / `ui-service.test`; this proves the visible layer.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DashboardIcon } from "../../preload";
import { DashboardIconsLayer } from "./icons-layer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

function appIcon(target: string, x: number, y: number): DashboardIcon {
	return { kind: "app", target, label: target.toUpperCase(), x, y } as unknown as DashboardIcon;
}
const ICONS: Record<string, DashboardIcon> = {
	chat: appIcon("chat", 0, 0),
	mail: appIcon("mail", 1, 0),
};

type BadgeEntry = { appId: string } & ({ count: number } | { dot: true });

describe("DashboardIconsLayer — app-icon badges (7.14)", () => {
	let host: HTMLDivElement;
	let root: Root;
	let emit: (entries: BadgeEntry[]) => void = () => undefined;

	beforeEach(() => {
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			apps: {
				listRunning: () => Promise.resolve([]),
				onRunningChanged: () => () => undefined,
				onBadgesChanged: (listener: (entries: BadgeEntry[]) => void) => {
					emit = listener;
					return () => undefined;
				},
				listInstalled: () => Promise.resolve([]),
				iconUrl: (id: string) => `brainstorm://app-icon/${id}`,
			},
		};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	async function mount(): Promise<void> {
		await act(async () => {
			root.render(
				<DashboardIconsLayer
					icons={ICONS}
					pins={{}}
					onMoveIcon={() => undefined}
					onActivate={() => undefined}
					gridMigrated={true}
					onGridMigrated={() => undefined}
				/>,
			);
		});
		await act(async () => undefined);
	}

	const badges = () => host.querySelectorAll<HTMLElement>(".dashboard-icons__badge");

	it("renders no badge until an app sets one", async () => {
		await mount();
		expect(badges().length).toBe(0);
	});

	it("renders a count chip, attributes it to the app, and caps at 99+", async () => {
		await mount();
		await act(async () => emit([{ appId: "chat", count: 3 }]));
		const chip = host.querySelector<HTMLElement>(".dashboard-icons__badge");
		expect(chip?.textContent).toBe("3");
		expect(chip?.getAttribute("role")).toBe("status");
		expect(chip?.getAttribute("aria-label")).toContain("CHAT");

		await act(async () => emit([{ appId: "chat", count: 250 }]));
		expect(host.querySelector(".dashboard-icons__badge")?.textContent).toBe("99+");
	});

	it("renders a dot chip with no number", async () => {
		await mount();
		await act(async () => emit([{ appId: "mail", dot: true }]));
		const dot = host.querySelector<HTMLElement>(".dashboard-icons__badge--dot");
		expect(dot).not.toBeNull();
		expect(dot?.textContent).toBe("");
	});

	it("clears the chip when the app drops out of the pushed set", async () => {
		await mount();
		await act(async () => emit([{ appId: "chat", count: 2 }]));
		expect(badges().length).toBe(1);
		await act(async () => emit([]));
		expect(badges().length).toBe(0);
	});
});

/**
 * @vitest-environment jsdom
 *
 * `<NotificationBell>` — pins the clear-all action actually firing the
 * `clearNotificationHistory` bridge call when the footer button is clicked,
 * plus the footer only existing when there's history to clear. Guards the
 * regression where the button rendered but did nothing.
 */

import type { NotificationRecord } from "@brainstorm-os/protocol/shell-prefs";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "./notification-center";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const clearNotificationHistory = vi.fn().mockResolvedValue(undefined);
const markAllNotificationsRead = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
	clearNotificationHistory.mockClear();
	markAllNotificationsRead.mockClear();
	(globalThis as unknown as { window: { brainstorm: unknown } }).window.brainstorm = {
		dashboard: { clearNotificationHistory, markAllNotificationsRead },
		apps: { listInstalled: vi.fn().mockResolvedValue([]), iconUrl: () => "" },
	};
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

async function flushPromises() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

function record(partial: Partial<NotificationRecord> = {}): NotificationRecord {
	return {
		id: "n1",
		appId: "notes",
		title: "Hello",
		kind: "info",
		ts: 1_700_000_000_000,
		read: true,
		...partial,
	};
}

function clearButton(): HTMLButtonElement | undefined {
	return Array.from(document.querySelectorAll("button")).find((b) =>
		b.textContent?.includes("Clear all"),
	);
}

describe("<NotificationBell>", () => {
	it("clicking Clear all calls clearNotificationHistory", async () => {
		act(() =>
			root.render(
				<NotificationBell
					unread={0}
					open={true}
					onToggle={vi.fn()}
					onClose={vi.fn()}
					history={[record()]}
					locale="en-US"
				/>,
			),
		);
		await flushPromises();
		const button = clearButton();
		expect(button).toBeDefined();
		act(() => button?.click());
		expect(clearNotificationHistory).toHaveBeenCalledTimes(1);
	});

	it("renders no Clear all button when history is empty", async () => {
		act(() =>
			root.render(
				<NotificationBell
					unread={0}
					open={true}
					onToggle={vi.fn()}
					onClose={vi.fn()}
					history={[]}
					locale="en-US"
				/>,
			),
		);
		await flushPromises();
		expect(clearButton()).toBeUndefined();
	});
});

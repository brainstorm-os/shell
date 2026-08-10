// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AccountView, FolderRole, type FolderView } from "../types/mail-view";
import { FolderRail } from "./folder-rail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const ACCOUNTS: AccountView[] = [
	{ id: "acc1", displayName: "me@example.com", address: "me@example.com" },
];

const FOLDERS: FolderView[] = [
	{
		id: "f1",
		accountRef: "acc1",
		path: "INBOX/Archive",
		role: FolderRole.Archive,
		unreadCount: 0,
		backfillDone: false,
	},
];

function render(open: boolean): void {
	act(() =>
		root.render(
			<FolderRail
				open={open}
				accounts={ACCOUNTS}
				folders={FOLDERS}
				selection={{ kind: "unified-inbox" }}
				unifiedUnread={2}
				onSelect={vi.fn()}
			/>,
		),
	);
}

const rail = (): HTMLElement => host.querySelector<HTMLElement>("#mb-rail") as HTMLElement;

describe("FolderRail collapsed state", () => {
	it("keeps the rail reachable while open", () => {
		render(true);
		expect(rail().hasAttribute("inert")).toBe(false);
		expect(rail().getAttribute("aria-hidden")).toBeNull();
	});

	// F-489 follow-up: the rail collapses via a 0px grid track, not a translate,
	// so its buttons stay rendered and focusable behind `overflow-x: hidden`.
	it("drops the collapsed rail out of the tab order and the a11y tree", () => {
		render(false);
		expect(rail().hasAttribute("inert")).toBe(true);
		expect(rail().getAttribute("aria-hidden")).toBe("true");
	});
});

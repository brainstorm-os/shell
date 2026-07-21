// @vitest-environment jsdom

import { type CommentDef, CommentKind } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommentsAdapter } from "./comments-adapter";
import { CommentsProvider } from "./comments-context";
import { CommentsRightPanel, RightPanelTab } from "./right-panel-tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function staticAdapter(rows: CommentDef[]): CommentsAdapter {
	return {
		list: () => rows,
		subscribe: () => () => {},
		add: () => Promise.resolve(),
		resolve: () => Promise.resolve(),
		reopen: () => Promise.resolve(),
		remove: () => Promise.resolve(),
		dispose: () => {},
	};
}

function comment(id: string, resolvedAt: number | null = null): CommentDef {
	return {
		id,
		kind: CommentKind.Comment,
		anchor: { entityId: "ent_doc", blockId: `blk-${id}` },
		body: `body ${id}`,
		parentId: null,
		createdAt: 1,
		updatedAt: 1,
		resolvedAt,
	};
}

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

function render(
	adapter: CommentsAdapter,
	active: RightPanelTab,
	onTabChange: (tab: RightPanelTab) => void = () => {},
): void {
	act(() => {
		root.render(
			<CommentsProvider adapter={adapter}>
				<CommentsRightPanel
					documentId="ent_doc"
					active={active}
					onTabChange={onTabChange}
					properties={<div data-testid="props-panel" />}
				/>
			</CommentsProvider>,
		);
	});
}

describe("CommentsRightPanel", () => {
	it("renders the tablist with the open-thread count badge", () => {
		render(staticAdapter([comment("a"), comment("b"), comment("c", 100)]), RightPanelTab.Properties);
		const tabs = [...container.querySelectorAll('[role="tab"]')];
		expect(tabs).toHaveLength(2);
		expect(container.querySelector('[role="tablist"]')).not.toBeNull();
		// 2 open threads (the resolved one doesn't count).
		expect(container.querySelector(".bs-panel-tab-badge")?.textContent).toBe("2");
	});

	it("shows the properties node on the Properties tab and the panel on Comments", () => {
		const adapter = staticAdapter([comment("a")]);
		render(adapter, RightPanelTab.Properties);
		expect(container.querySelector('[data-testid="props-panel"]')).not.toBeNull();
		expect(container.querySelector(".bs-comments")).toBeNull();
		render(adapter, RightPanelTab.Comments);
		expect(container.querySelector('[data-testid="props-panel"]')).toBeNull();
		expect(container.querySelector(".bs-comments")).not.toBeNull();
	});

	it("clicking a tab commits through onTabChange", () => {
		let picked: RightPanelTab | null = null;
		render(staticAdapter([]), RightPanelTab.Properties, (tab) => {
			picked = tab;
		});
		const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
		act(() => tabs[1]?.click());
		expect(picked).toBe(RightPanelTab.Comments);
	});

	it("hides the badge when no thread is open", () => {
		render(staticAdapter([comment("a", 5)]), RightPanelTab.Properties);
		expect(container.querySelector(".bs-panel-tab-badge")).toBeNull();
	});
});

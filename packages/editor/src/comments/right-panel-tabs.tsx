/**
 * Shared right-panel tab strip + tabbed panel body (B11.9) — the one
 * Properties | Comments switcher every editor app's right inspector renders,
 * so the chrome is identical across Notes / Journal / Tasks / Bookmarks
 * (extracted at copy two: Notes shipped it first, Journal is the second
 * consumer). A focus-then-commit `tablist` driven by the shared
 * `@brainstorm-os/sdk/a11y` composite keyboard (roles come from the binding
 * spread, not literals); arrow keys move + commit, Enter / click select.
 *
 * Render `<CommentsRightPanel>` inside a `CommentsProvider` so the Comments
 * tab badge reflects the live open-thread count even while the Properties
 * tab is showing.
 */

import type { CommentAnchor } from "@brainstorm-os/sdk-types";
import { Orientation, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import type { ReactNode } from "react";
import { useEditorT } from "../i18n";
import { useComments } from "./comments-context";
import {
	type CommentsFocusRequest,
	CommentsPanel,
	type CommentsPanelProps,
} from "./comments-panel";

export enum RightPanelTab {
	Properties = "properties",
	Comments = "comments",
	/** 10.16 — present only when the host passes a `history` panel. */
	History = "history",
}

const BASE_TABS = [RightPanelTab.Properties, RightPanelTab.Comments] as const;
const WITH_HISTORY = [...BASE_TABS, RightPanelTab.History] as const;

const TAB_LABEL_KEY = {
	[RightPanelTab.Properties]: "editor.rightPanel.properties",
	[RightPanelTab.Comments]: "editor.rightPanel.comments",
	[RightPanelTab.History]: "editor.rightPanel.history",
} as const;

export function RightPanelTabs({
	active,
	onChange,
	openCommentCount,
	withHistory = false,
}: {
	active: RightPanelTab;
	onChange: (tab: RightPanelTab) => void;
	openCommentCount: number;
	withHistory?: boolean;
}): ReactNode {
	const t = useEditorT();
	const order: readonly RightPanelTab[] = withHistory ? WITH_HISTORY : BASE_TABS;
	const activeIndex = Math.max(0, order.indexOf(active));
	const commit = (index: number): void => {
		const tab = order[index];
		if (tab) onChange(tab);
	};
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: order.length,
		activeIndex,
		onActiveIndexChange: commit,
		onActivate: commit,
		role: "tablist",
		itemRole: "tab",
		useAriaActiveDescendant: true,
	});

	return (
		<div {...containerProps} className="bs-panel-tabs" aria-label={t("editor.rightPanel.tabs")}>
			{order.map((tab, index) => (
				<button
					key={tab}
					type="button"
					{...getItemProps(index)}
					className="bs-panel-tab"
					data-active={tab === active}
					onClick={() => onChange(tab)}
				>
					{t(TAB_LABEL_KEY[tab])}
					{tab === RightPanelTab.Comments && openCommentCount > 0 && (
						<span className="bs-panel-tab-badge">{openCommentCount}</span>
					)}
				</button>
			))}
		</div>
	);
}

/** The tabbed right-panel body. `properties` is the host app's already-built
 *  Properties panel node (it consumes the app's own providers). */
export function CommentsRightPanel({
	documentId,
	active,
	onTabChange,
	properties,
	pendingAnchor,
	onClearPending,
	focusRequest,
	onApplySuggestion,
	history,
}: {
	documentId: string;
	active: RightPanelTab;
	onTabChange: (tab: RightPanelTab) => void;
	properties: ReactNode;
	/** 10.16 — the host's `<VersionHistoryPanel>`; adds a History tab. */
	history?: ReactNode;
	pendingAnchor?: CommentAnchor;
	onClearPending?: () => void;
	focusRequest?: CommentsFocusRequest | null;
	onApplySuggestion?: CommentsPanelProps["onApplySuggestion"];
}): ReactNode {
	const { openCount } = useComments();
	return (
		<>
			<RightPanelTabs
				active={active}
				onChange={onTabChange}
				openCommentCount={openCount}
				withHistory={history !== undefined}
			/>
			{active === RightPanelTab.Properties ? (
				properties
			) : active === RightPanelTab.History && history !== undefined ? (
				<div className="bs-panel-scroll">{history}</div>
			) : (
				<CommentsPanel
					documentId={documentId}
					{...(pendingAnchor ? { pendingAnchor } : {})}
					{...(onClearPending ? { onClearPending } : {})}
					{...(focusRequest ? { focusRequest } : {})}
					{...(onApplySuggestion ? { onApplySuggestion } : {})}
				/>
			)}
		</>
	);
}

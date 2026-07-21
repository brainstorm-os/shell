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
}

const TAB_ORDER = [RightPanelTab.Properties, RightPanelTab.Comments] as const;

export function RightPanelTabs({
	active,
	onChange,
	openCommentCount,
}: {
	active: RightPanelTab;
	onChange: (tab: RightPanelTab) => void;
	openCommentCount: number;
}): ReactNode {
	const t = useEditorT();
	const activeIndex = Math.max(0, TAB_ORDER.indexOf(active));
	const commit = (index: number): void => {
		const tab = TAB_ORDER[index];
		if (tab) onChange(tab);
	};
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: TAB_ORDER.length,
		activeIndex,
		onActiveIndexChange: commit,
		onActivate: commit,
		role: "tablist",
		itemRole: "tab",
		useAriaActiveDescendant: true,
	});

	return (
		<div {...containerProps} className="bs-panel-tabs" aria-label={t("editor.rightPanel.tabs")}>
			{TAB_ORDER.map((tab, index) => (
				<button
					key={tab}
					type="button"
					{...getItemProps(index)}
					className="bs-panel-tab"
					data-active={tab === active}
					onClick={() => onChange(tab)}
				>
					{tab === RightPanelTab.Properties
						? t("editor.rightPanel.properties")
						: t("editor.rightPanel.comments")}
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
}: {
	documentId: string;
	active: RightPanelTab;
	onTabChange: (tab: RightPanelTab) => void;
	properties: ReactNode;
	pendingAnchor?: CommentAnchor;
	onClearPending?: () => void;
	focusRequest?: CommentsFocusRequest | null;
	onApplySuggestion?: CommentsPanelProps["onApplySuggestion"];
}): ReactNode {
	const { openCount } = useComments();
	return (
		<>
			<RightPanelTabs active={active} onChange={onTabChange} openCommentCount={openCount} />
			{active === RightPanelTab.Properties ? (
				properties
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

/**
 * Declared keyboard surface for Chat. Every binding routes through
 * `@brainstorm-os/sdk/shortcut` (no raw `e.key`); chord syntax is the shared
 * shell registry syntax.
 */

import { attachShortcut } from "@brainstorm-os/sdk/shortcut";
import { type RefObject, useEffect, useRef } from "react";

export enum ChatAction {
	Search = "chat.search",
	SearchAll = "chat.search-all",
	CloseSearch = "chat.close-search",
	MarkAllRead = "chat.mark-all-read",
	ToggleComposer = "chat.toggle-composer",
}

export const CHAT_CHORDS: Readonly<Record<ChatAction, string>> = {
	[ChatAction.Search]: "CmdOrCtrl+F",
	[ChatAction.SearchAll]: "CmdOrCtrl+Shift+F",
	[ChatAction.CloseSearch]: "Escape",
	[ChatAction.MarkAllRead]: "Shift+Escape",
	[ChatAction.ToggleComposer]: "CmdOrCtrl+Shift+E",
};

/** Single-key chords that must fire even while focus is in a text field
 *  (Escape out of the search box; Shift+Escape from the composer). */
const ALLOW_WHILE_TYPING: ReadonlySet<ChatAction> = new Set([
	ChatAction.CloseSearch,
	ChatAction.MarkAllRead,
]);

export function useChatShortcut(
	action: ChatAction,
	handler: () => void,
	options: { enabled?: boolean; scope?: RefObject<HTMLElement | null> } = {},
): void {
	const handlerRef = useRef(handler);
	handlerRef.current = handler;
	const enabled = options.enabled ?? true;
	const scope = options.scope ?? null;
	useEffect(() => {
		if (!enabled) return;
		const target: Window | HTMLElement | null = scope ? scope.current : window;
		if (!target) return;
		return attachShortcut(target, CHAT_CHORDS[action], () => handlerRef.current(), {
			allowWhileSuppressed: ALLOW_WHILE_TYPING.has(action),
		});
	}, [action, enabled, scope]);
}

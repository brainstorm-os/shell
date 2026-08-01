/**
 * Menu-action dispatch per §Triggering:
 *
 *   When the user clicks a menu item:
 *     1. The shell's menu handler resolves the click to the contributing app's id.
 *     2. If it's a shell item, the shell handles directly.
 *     3. If it's an app item, the shell dispatches an internal-intent to the
 *        focused app's renderer (a **private channel** for menu actions, not
 *        the public `intent.dispatch`).
 *     4. The app's menu handler executes the action.
 *
 * The "internal-intent" lives on a dedicated ipcMain → renderer channel
 * (`menu:invoke` — subscribed by the app preload's Tool-1 handler registry
 * as `menu:<action>` handlers) instead of going through the broker — it's a trusted
 * shell→app message, doesn't need capability checking, and the renderer
 * preload re-exposes it as a `brainstorm.on("menu", ...)` lifecycle-style
 * event in Stage 5b alongside the rest of the lifecycle wiring.
 *
 * Stage 6 lands the main-side mechanics + a `ShellMenuRouter` for shell-owned
 * clicks. The renderer-side handlers attach when apps are launched (the
 * preload subscribes; the SDK runtime fires the event).
 */

import { resolveMenuItemId } from "./menu-composer";

export const MENU_INVOKE_CHANNEL = "menu:invoke" as const;

export type MenuClickPayload = { topicId?: string };
export type ShellMenuHandler = (action: string, payload?: MenuClickPayload) => void | Promise<void>;

/**
 * Routes shell-owned menu clicks (`shell/<action>`) to registered handlers
 * and forwards app-owned clicks via a sender callback that posts to the
 * right renderer on the private channel.
 */
export class MenuRouter {
	private readonly shellHandlers = new Map<string, ShellMenuHandler>();

	constructor(
		private readonly sendToFocusedApp: (appId: string, payload: { action: string }) => void,
	) {}

	registerShellHandler(action: string, handler: ShellMenuHandler): void {
		this.shellHandlers.set(action, handler);
	}

	unregisterShellHandler(action: string): void {
		this.shellHandlers.delete(action);
	}

	listShellActions(): string[] {
		return [...this.shellHandlers.keys()].sort();
	}

	/**
	 * Dispatch a menu-item click. Returns:
	 *   - `{ kind: "shell", action }` and runs the handler if known.
	 *   - `{ kind: "shell-unknown", action }` for shell ids without a handler
	 *     (caller logs / no-ops).
	 *   - `{ kind: "app", appId, action }` and forwards via `sendToFocusedApp`.
	 *   - `{ kind: "malformed" }` for unparseable ids.
	 */
	async dispatch(itemId: string, payload?: MenuClickPayload): Promise<DispatchResult> {
		const parsed = resolveMenuItemId(itemId);
		if (!parsed) return { kind: "malformed" };
		if (parsed.owner === "shell") {
			const handler = this.shellHandlers.get(parsed.action);
			if (!handler) {
				const prefixMatch = [...this.shellHandlers.keys()].find(
					(action) => parsed.action === action || parsed.action.startsWith(`${action}.`),
				);
				if (prefixMatch) {
					const matched = this.shellHandlers.get(prefixMatch);
					if (matched) {
						await matched(parsed.action, payload);
						return { kind: "shell", action: parsed.action };
					}
				}
				return { kind: "shell-unknown", action: parsed.action };
			}
			await handler(parsed.action, payload);
			return { kind: "shell", action: parsed.action };
		}
		this.sendToFocusedApp(parsed.owner, { action: parsed.action });
		return { kind: "app", appId: parsed.owner, action: parsed.action };
	}
}

export type DispatchResult =
	| { kind: "shell"; action: string }
	| { kind: "shell-unknown"; action: string }
	| { kind: "app"; appId: string; action: string }
	| { kind: "malformed" };

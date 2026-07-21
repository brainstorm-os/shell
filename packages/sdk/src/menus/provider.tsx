/**
 * `BrainstormMenuProvider` — the single fancy-menus root every renderer
 * (the shell dashboard + each first-party app) mounts once, high in its
 * tree. It owns one `MenuStore`, wires Brainstorm's cross-cutting concerns
 * into the menu runtime, and registers the shortcut-suppression seam so an
 * open menu silences global single-key chords for free.
 *
 * Why a wrapper rather than using `<MenuProvider>` directly at each root:
 *   - DRY — suppression wiring, error routing, and locale defaults are
 *     declared once instead of re-derived at ~10 call sites.
 *   - The store reference has to be ours to feed `store.isOpen()` into the
 *     suppression registry (the bare `<MenuProvider>` creates its own).
 *
 * Theme is handled entirely in CSS (`@brainstorm-os/sdk/menus.css` bridges
 * `--fm-*` → `--color-*`), so it recolours reactively on theme switch and
 * isn't passed here as a static `ThemeTokens` snapshot.
 */

import { MenuState, type ProviderOptions } from "@react-fancy-menus/core";
import { MenuProvider, MenuStore } from "@react-fancy-menus/core/runtime";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { getEscapeStack } from "../a11y";
import { registerShortcutSuppression } from "../shortcut";
import { mountTooltipHost } from "../tooltip";
import { setActiveMenuStore } from "./active-store";
import { closeContextMenu } from "./context-menu";
import { type MenuLocale, resolveMenuLocale } from "./locale";

export type BrainstormMenuProviderProps = {
	/** Optional — a standalone host (`mountMenuHost`) renders the provider
	 *  with no children, purely to own the store + portal the menu stack. */
	children?: ReactNode;
	/** Host translations for the menu chrome; only the keys you translate. */
	locale?: Partial<MenuLocale>;
	/**
	 * Surfaced from the runtime's global error hook. Hosts forward this to
	 * their error-log capture; a no-op host still gets the console.error.
	 */
	onError?: (error: unknown, menuId: string) => void;
};

export function BrainstormMenuProvider({ children, locale, onError }: BrainstormMenuProviderProps) {
	// One store for the provider's lifetime — its `isOpen()` feeds the
	// suppression seam, and `dispose()` clears pending open/close timers.
	const storeRef = useRef<MenuStore | null>(null);
	if (storeRef.current == null) storeRef.current = new MenuStore();
	const store = storeRef.current;

	// An open menu owns the keyboard: global single-key chords (`t`, `d`,
	// the launcher key) must not fire while it's up. Modifier chords still
	// pass — that gate lives in `attachShortcut`, not here. See the seam
	// contract in `shortcut/suppression.ts`.
	useEffect(() => registerShortcutSuppression(() => store.isOpen()), [store]);

	// Stand up the delegated tooltip controller alongside the menu runtime —
	// every app mounts this provider once, so wiring it here gives the whole
	// app the animated `.bs-tooltip` chip (over the native OS tooltip) for
	// free. Refcounted, so a second provider / StrictMode just bumps the count.
	useEffect(() => mountTooltipHost(), []);

	// Publish the store so imperative openers (`openContextMenu`, the
	// anchored object/graph/database menus) reach the same instance this
	// provider renders. Cleared on unmount → imperative opens fail soft.
	useEffect(() => {
		setActiveMenuStore(store);
		return () => {
			// Drop any active-trigger tracking (the `aria-expanded` + the store
			// subscription `openContextMenu` registers) before the store is gone,
			// so a torn-down renderer doesn't retain the trigger element.
			closeContextMenu();
			setActiveMenuStore(null);
			// Clear timers so a torn-down renderer doesn't leak a scheduled
			// open→open / closing→removed transition.
			store.dispose();
		};
	}, [store]);

	// Outside-pointer dismissal, independent of the dimmer. The runtime's only
	// built-in mouse dismiss is a click on the full-screen `.fm-dimmer`, so a
	// menu opened with `DimmerMode.None`/`PassThrough` (editor typeaheads) or
	// one whose dimmer pointerdown is swallowed (the Electron drag-region case)
	// has NO way to close on an outside click — it sticks open and, with the
	// dimmer still overlaying, eats every subsequent click (routing dies). A
	// single capture-phase `pointerdown` on the document closes the whole stack
	// the moment a press lands outside every live menu panel and outside the
	// trigger that owns an open menu (which carries `aria-expanded="true"` and
	// runs its own toggle). This is the standard robust dismissal and makes the
	// dimmer a visual affordance, not the sole dismiss path.
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!store.isOpen()) return;
			const target = event.target;
			if (!(target instanceof Element)) return;
			// A press inside a menu panel is the row/header/filter's to handle.
			if (target.closest(".fm-menu")) return;
			// The open menu's own trigger owns the toggle; closing here would
			// race its reopen on the following click.
			if (target.closest('[aria-expanded="true"]')) return;
			store.closeAll();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => document.removeEventListener("pointerdown", onPointerDown, true);
	}, [store]);

	// Bridge open menus onto the renderer-wide escape stack so Escape closes
	// the topmost menu (LIFO with `<Popover>` overlays) and the capture-phase
	// handler stops a global Escape chord from swallowing the key first. One
	// entry per live menu; reconciled on every store change.
	useEffect(() => {
		const stack = getEscapeStack();
		const entries = new Map<string, () => void>();
		const reconcile = () => {
			const live = new Set(
				store
					.getAll()
					.filter((m) => m.state !== MenuState.Closing && m.state !== MenuState.Closed)
					.map((m) => m.id),
			);
			for (const id of live) {
				if (!entries.has(id)) {
					entries.set(id, stack.push({ id: `fm:${id}`, onEscape: () => store.close(id) }));
				}
			}
			for (const [id, off] of entries) {
				if (!live.has(id)) {
					off();
					entries.delete(id);
				}
			}
		};
		const unsub = store.subscribe(reconcile);
		reconcile();
		return () => {
			unsub();
			for (const off of entries.values()) off();
			entries.clear();
		};
	}, [store]);

	const options = useMemo<ProviderOptions>(
		() => ({
			locale: resolveMenuLocale(locale),
			onError: (error, ctx) => {
				console.error(`[menus] ${ctx.menuId}:`, error);
				onError?.(error, ctx.menuId);
			},
		}),
		[locale, onError],
	);

	return (
		<MenuProvider store={store} options={options}>
			{children}
		</MenuProvider>
	);
}

// @vitest-environment jsdom
/**
 * Foundation tests for `@brainstorm-os/sdk/menus`:
 *   - locale defaults + partial-override merge (SDK i18n convention)
 *   - the suppression seam: an open menu silences global single-key chords
 *     (`store.isOpen()` flows into the shortcut suppression registry), and
 *     the source is removed when the provider unmounts.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAnchoredMenu } from "../object-menu/anchored-menu";
import { openObjectMenu } from "../object-menu/open-object-menu";
import { isAnyShortcutSuppressed } from "../shortcut";
import { _resetShortcutSuppressionForTests } from "../shortcut/suppression";
import { getActiveMenuStore } from "./active-store";
import {
	BodyKind,
	BrainstormMenuProvider,
	CONTEXT_MENU_ID,
	CONTEXT_SUBMENU_ID,
	MenuAlign,
	closeContextMenu,
	contextMenuConfig,
	contextSubMenuConfig,
	defineMenu,
	openContextMenu,
	useMenu,
} from "./index";
import { DEFAULT_MENU_LOCALE, resolveMenuLocale } from "./locale";

describe("resolveMenuLocale", () => {
	it("returns the defaults by identity and merges a partial override", () => {
		expect(resolveMenuLocale()).toBe(DEFAULT_MENU_LOCALE);
		expect(resolveMenuLocale({ done: "Fertig" })).toEqual({
			...DEFAULT_MENU_LOCALE,
			done: "Fertig",
		});
	});
});

const probe = defineMenu({
	id: "test/probe",
	body: { kind: BodyKind.Custom, render: () => null },
});

function Opener({ onReady }: { onReady: (api: ReturnType<typeof useMenu>) => void }) {
	const api = useMenu();
	onReady(api);
	return null;
}

describe("<BrainstormMenuProvider> suppression seam", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		_resetShortcutSuppressionForTests();
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		_resetShortcutSuppressionForTests();
	});

	it("suppresses chords while a menu is open and stops on close + unmount", () => {
		let api!: ReturnType<typeof useMenu>;
		act(() => {
			root.render(
				<BrainstormMenuProvider>
					<Opener
						onReady={(a) => {
							api = a;
						}}
					/>
				</BrainstormMenuProvider>,
			);
		});

		// Mounted but idle — nothing owns the keyboard.
		expect(isAnyShortcutSuppressed()).toBe(false);

		act(() => {
			api.register(probe);
			api.open(probe.id);
		});
		expect(isAnyShortcutSuppressed()).toBe(true);

		act(() => api.close(probe.id));
		expect(isAnyShortcutSuppressed()).toBe(false);

		// Reopen, then tear the provider down: the source must unregister so
		// it can't keep suppressing chords in a renderer that no longer exists.
		act(() => api.open(probe.id));
		expect(isAnyShortcutSuppressed()).toBe(true);
		act(() => root.unmount());
		expect(isAnyShortcutSuppressed()).toBe(false);
	});

	it("publishes its store for imperative openers and clears it on unmount", () => {
		expect(getActiveMenuStore()).toBeNull();
		act(() => {
			root.render(
				<BrainstormMenuProvider>
					<div />
				</BrainstormMenuProvider>,
			);
		});
		const store = getActiveMenuStore();
		expect(store).not.toBeNull();

		// Imperative open registers the shared config on first use and opens it.
		act(() =>
			expect(
				openContextMenu({ x: 10, y: 10 }, [{ id: "a", label: "A", onSelect: () => undefined }]),
			).toBe(true),
		);
		expect(store?.isOpen(CONTEXT_MENU_ID)).toBe(true);
		expect(isAnyShortcutSuppressed()).toBe(true);

		act(() => closeContextMenu());
		expect(store?.isOpen(CONTEXT_MENU_ID)).toBe(false);

		act(() => root.unmount());
		expect(getActiveMenuStore()).toBeNull();
	});

	it("openContextMenu fails soft when no provider is mounted", () => {
		expect(getActiveMenuStore()).toBeNull();
		expect(openContextMenu({ x: 0, y: 0 }, [])).toBe(false);
	});

	it("anchors the opened menu at the click point (not the viewport centre)", () => {
		act(() => {
			root.render(
				<BrainstormMenuProvider>
					<div />
				</BrainstormMenuProvider>,
			);
		});
		const store = getActiveMenuStore();
		act(() =>
			openContextMenu({ x: 120, y: 240 }, [{ id: "a", label: "A", onSelect: () => undefined }]),
		);
		// The runtime positions from `param.rect` (it ignores `position.fixedX/Y`);
		// a collapsed rect at the point makes the menu open from there.
		const open = store?.getAll().find((m) => m.id === CONTEXT_MENU_ID);
		const rect = open?.param.rect as DOMRect | undefined;
		expect(rect).toMatchObject({ left: 120, top: 240, width: 0, height: 0 });
		act(() => closeContextMenu());
		act(() => root.unmount());
	});

	it("anchors to the trigger element, right-aligns, and marks it open until close", () => {
		act(() => {
			root.render(
				<BrainstormMenuProvider>
					<div />
				</BrainstormMenuProvider>,
			);
		});
		const store = getActiveMenuStore();
		const trigger = document.createElement("button");
		document.body.appendChild(trigger);

		act(() =>
			openContextMenu({ x: 0, y: 0 }, [{ id: "a", label: "A", onSelect: () => undefined }], {
				anchor: trigger,
				align: MenuAlign.End,
			}),
		);
		// A right-aligned (`End`) anchor opens the `:end` variant, positioned
		// from the element's live rect (not a point), and the trigger carries
		// the open state so its active/hover styling shows.
		const endId = `${CONTEXT_MENU_ID}:end`;
		expect(store?.isOpen(endId)).toBe(true);
		expect(store?.getConfig(endId)?.position?.horizontal).toBe("right");
		const open = store?.getAll().find((m) => m.id === endId);
		expect(open?.param.element).toBe(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");

		// Closing clears the open state (the store-close path that escape /
		// outside-click also flow through).
		act(() => closeContextMenu());
		expect(trigger.getAttribute("aria-expanded")).toBeNull();

		trigger.remove();
		act(() => root.unmount());
	});

	it("freezes the menu position at open (followAnchor off) so a removed trigger can't snap it to 0,0", () => {
		act(() => {
			root.render(
				<BrainstormMenuProvider>
					<div />
				</BrainstormMenuProvider>,
			);
		});
		const store = getActiveMenuStore();
		const trigger = document.createElement("button");
		document.body.appendChild(trigger);

		act(() =>
			openContextMenu({ x: 0, y: 0 }, [{ id: "a", label: "A", onSelect: () => undefined }], {
				anchor: trigger,
			}),
		);
		// Position is computed once and frozen: an action that unmounts its own
		// trigger (Delete a row) must not leave autoUpdate repositioning against a
		// disconnected element whose rect is all-zeros (the top-left-corner snap).
		expect(store?.getConfig(CONTEXT_MENU_ID)?.position?.followAnchor).toBe(false);

		act(() => closeContextMenu());
		trigger.remove();
		act(() => root.unmount());
	});

	it("closes an anchored menu when its trigger leaves the document (route change)", async () => {
		act(() => {
			root.render(
				<BrainstormMenuProvider>
					<div />
				</BrainstormMenuProvider>,
			);
		});
		const store = getActiveMenuStore();
		const trigger = document.createElement("button");
		document.body.appendChild(trigger);

		act(() =>
			openContextMenu({ x: 0, y: 0 }, [{ id: "a", label: "A", onSelect: () => undefined }], {
				anchor: trigger,
			}),
		);
		expect(store?.isOpen(CONTEXT_MENU_ID)).toBe(true);

		// Unmounting the trigger (a route swap, a keyed list re-render) must
		// close the menu — a menu positioned from a disconnected element
		// collapses to the viewport origin and hangs in the top-left corner.
		trigger.remove();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(store?.isOpen(CONTEXT_MENU_ID)).toBe(false);

		act(() => root.unmount());
	});

	it("openAnchoredMenu delegates to the store when a host is mounted (no legacy DOM)", () => {
		act(() => {
			root.render(
				<BrainstormMenuProvider>
					<div />
				</BrainstormMenuProvider>,
			);
		});
		const store = getActiveMenuStore();
		act(() =>
			openAnchoredMenu({ x: 5, y: 5 }, [{ label: "Rename", onSelect: () => undefined }], {
				menuLabel: "Object",
			}),
		);
		// A labelled menu opens a per-label config variant whose `role="menu"`
		// container carries the menuLabel as its accessible name (the label was
		// dropped on the floor before — F1).
		const labelledId = `${CONTEXT_MENU_ID}:Object`;
		expect(store?.isOpen(labelledId)).toBe(true);
		expect(store?.getConfig(labelledId)?.chrome?.ariaLabel).toBe("Object");
		// The legacy self-contained popup must NOT render when delegating.
		expect(document.querySelector(".bs-object-menu")).toBeNull();
		act(() => closeContextMenu());
		expect(store?.isOpen(labelledId)).toBe(false);
		act(() => root.unmount());
	});

	// The provider's dimmer-independent outside-pointer dismissal. The runtime's
	// only built-in mouse dismiss is a click on the `.fm-dimmer`; without this a
	// `DimmerMode.None` menu — or one whose dimmer pointerdown is swallowed —
	// can't close on an outside click and traps every subsequent click (the
	// Tasks ⋯-menu → sidebar dead-click). Capture-phase so it fires regardless
	// of who else stops propagation.
	function firePointerDown(target: Element): void {
		act(() => {
			target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		});
	}

	it("closes the menu stack on an outside pointerdown (no dimmer click needed)", () => {
		act(() => {
			root.render(
				<BrainstormMenuProvider>
					<div />
				</BrainstormMenuProvider>,
			);
		});
		const store = getActiveMenuStore();
		const outside = document.createElement("button");
		outside.textContent = "Inbox";
		document.body.appendChild(outside);

		act(() =>
			openContextMenu({ x: 10, y: 10 }, [{ id: "a", label: "A", onSelect: () => undefined }]),
		);
		expect(store?.isOpen(CONTEXT_MENU_ID)).toBe(true);

		// A press anywhere outside the menu panel dismisses it — the press the
		// dimmer would otherwise have to catch.
		firePointerDown(outside);
		expect(store?.isOpen(CONTEXT_MENU_ID)).toBe(false);

		outside.remove();
		act(() => root.unmount());
	});

	it("does NOT close on a pointerdown inside the menu panel or on its open trigger", () => {
		act(() => {
			root.render(
				<BrainstormMenuProvider>
					<div />
				</BrainstormMenuProvider>,
			);
		});
		const store = getActiveMenuStore();
		const trigger = document.createElement("button");
		document.body.appendChild(trigger);

		act(() =>
			openContextMenu({ x: 0, y: 0 }, [{ id: "a", label: "A", onSelect: () => undefined }], {
				anchor: trigger,
			}),
		);
		expect(store?.isOpen(CONTEXT_MENU_ID)).toBe(true);

		// A press inside the rendered panel is the row's to handle — it must
		// never tear the menu down out from under the click.
		const panel = document.querySelector(".fm-menu");
		expect(panel).not.toBeNull();
		firePointerDown(panel as Element);
		expect(store?.isOpen(CONTEXT_MENU_ID)).toBe(true);

		// The trigger owns the toggle (it carries `aria-expanded="true"`); a
		// press on it must not close-then-reopen.
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		firePointerDown(trigger);
		expect(store?.isOpen(CONTEXT_MENU_ID)).toBe(true);

		act(() => closeContextMenu());
		trigger.remove();
		act(() => root.unmount());
	});
});

describe("context-menu cascade (submenus)", () => {
	it("wires the parent row to the shared child and positions the child to the row's right", () => {
		// The top-level menu declares the child slot; the child re-declares it so
		// a cascade nests to any depth through one registered config.
		const slot = contextMenuConfig.subMenus?.submenu;
		expect(slot?.menuId).toBe(CONTEXT_SUBMENU_ID);
		expect(slot?.trigger).toBe("arrowHover");
		expect(contextSubMenuConfig.subMenus?.submenu?.menuId).toBe(CONTEXT_SUBMENU_ID);

		// The child opens BESIDE the spawning row — the runtime resolves
		// `Vertical.Center` + `Horizontal.Right` to a Floating-UI `right`
		// placement (vertically centred on the row, flipping left near the
		// viewport edge). It must NOT anchor above/below the row: that overlaps
		// the parent menu and makes the child unreachable. It carries no dimmer
		// of its own — the runtime drops it for parented menus.
		expect(contextSubMenuConfig.position?.vertical).toBe("center");
		expect(contextSubMenuConfig.position?.horizontal).toBe("right");
		expect(contextSubMenuConfig.chrome?.dimmer).toBe("none");
	});

	// The fancy-menus list virtualizes its rows, and a jsdom scroller measures
	// 0px high, so no row DOM is produced under test. Assert instead on the data
	// the store was opened with: that the `submenu` field survives each mapping
	// layer (object → anchored → context) and reaches the runtime.
	describe("submenu survives the open pipeline", () => {
		let host: HTMLDivElement;
		let root: Root;

		beforeEach(() => {
			_resetShortcutSuppressionForTests();
			host = document.createElement("div");
			document.body.appendChild(host);
			root = createRoot(host);
			act(() => {
				root.render(
					<BrainstormMenuProvider>
						<div />
					</BrainstormMenuProvider>,
				);
			});
		});
		afterEach(() => {
			act(() => closeContextMenu());
			act(() => root.unmount());
			host.remove();
			document.body.innerHTML = "";
			_resetShortcutSuppressionForTests();
		});

		type Items = { items: Array<{ label: string; submenu?: unknown[] }> };
		function openedItems(): Items["items"] {
			const open = getActiveMenuStore()
				?.getAll()
				.find((m) => (m.param.data as Items | undefined)?.items);
			return (open?.param.data as Items | undefined)?.items ?? [];
		}
		function find(label: string): { submenu?: unknown[] } | undefined {
			return openedItems().find((i) => i.label === label);
		}

		it("openContextMenu carries the children and registers the shared child config", () => {
			const store = getActiveMenuStore();
			act(() =>
				openContextMenu({ x: 0, y: 0 }, [
					{
						id: "layout",
						label: "Diff layout",
						submenu: [
							{ id: "side", label: "Side by side", onSelect: () => undefined },
							{ id: "unified", label: "Unified", onSelect: () => undefined },
						],
					},
				]),
			);
			expect(store?.getConfig(CONTEXT_SUBMENU_ID)).toBeTruthy();
			expect(find("Diff layout")?.submenu).toHaveLength(2);
		});

		it("threads a submenu through openAnchoredMenu (anchored → context map)", () => {
			act(() =>
				openAnchoredMenu(
					{ x: 0, y: 0 },
					[
						{
							label: "Syntax theme",
							submenu: [{ label: "GitHub Light", onSelect: () => undefined }],
						},
					],
					{ menuLabel: "Editor" },
				),
			);
			expect(find("Syntax theme")?.submenu).toHaveLength(1);
		});

		it("threads an extraItem submenu through openObjectMenu (object → anchored → context map)", async () => {
			await act(async () => {
				await openObjectMenu(
					{ x: 0, y: 0 },
					{
						target: { entityId: "e1", entityType: "io.acme/Doc/v1", label: "Spec" },
						runtime: { capabilities: [], services: { intents: { dispatch: () => undefined } } },
						extraItems: [
							{
								id: "syntax-theme",
								label: "Syntax theme",
								run: () => undefined,
								submenu: [{ id: "light", label: "GitHub Light", run: () => undefined }],
							},
						],
					},
				);
			});
			expect(find("Syntax theme")?.submenu).toHaveLength(1);
		});
	});
});

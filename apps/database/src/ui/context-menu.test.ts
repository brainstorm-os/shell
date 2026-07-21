/**
 * @vitest-environment jsdom
 *
 * Object-menu no-regression guard (Wave-3 Database polish, B-1 parity).
 *
 * Database is the object-menu *reference adopter*: after B-1 it no longer
 * owns a forked popup. Two seams must keep holding or the whole "one menu,
 * many call sites" contract silently regresses:
 *
 *  1. The private `context-menu.ts` is a 1:1 adapter (Database's historical
 *     `{label,onClick,destructive,disabled}` shape → the SDK
 *     `openAnchoredMenu` row) — the SAME glass chrome the cross-app object
 *     menu uses. Asserted against the *real* SDK rendered DOM (no module
 *     mock — the shared menu is a singleton, mocking it pollutes the
 *     boot-smoke test that imports `app.ts`).
 *  2. The per-object stage menu must route through the shared
 *     `@brainstorm-os/sdk/object-menu` `openObjectMenu` (pin pre-fetch +
 *     identical Open/Pin order), never a hand-rolled item array. Asserted
 *     as an `app.ts` source contract.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IconName } from "@brainstorm-os/sdk/icon";
import { closeAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeContextMenu, openContextMenu } from "./context-menu";

afterEach(() => {
	closeAnchoredMenu();
	document.body.replaceChildren();
});

describe("Database context-menu adapter renders through the shared SDK anchored menu", () => {
	it("maps {label,onClick,destructive,disabled} 1:1 onto the shared glass menu DOM", () => {
		const onA = vi.fn();
		const onB = vi.fn();

		openContextMenu({ x: 12, y: 34 }, [
			{ label: "Rename", onClick: onA },
			{ label: "Delete", onClick: onB, destructive: true, disabled: true },
		]);

		const menu = document.querySelector<HTMLElement>(".bs-object-menu");
		expect(menu).not.toBeNull();
		expect(menu?.getAttribute("role")).toBe("menu");
		expect(menu?.getAttribute("aria-label")).toBe("Database menu");

		const items = menu?.querySelectorAll<HTMLButtonElement>(".bs-object-menu__item");
		expect(items).toHaveLength(2);

		const [rename, del] = Array.from(items ?? []);
		expect(rename?.textContent).toBe("Rename");
		expect(rename?.disabled).toBe(false);
		expect(rename?.dataset.destructive).toBeUndefined();
		rename?.click();
		expect(onA).toHaveBeenCalledTimes(1);

		expect(del?.textContent).toBe("Delete");
		expect(del?.disabled).toBe(true);
		expect(del?.dataset.destructive).toBe("true");
		del?.click();
		expect(onB).not.toHaveBeenCalled();
	});

	it("passes a leading icon and a disabled-row hint through to the shared menu", () => {
		openContextMenu({ x: 0, y: 0 }, [
			{ label: "Rename", icon: IconName.Pencil, onClick: () => {} },
			{
				label: "Delete",
				icon: IconName.Trash,
				destructive: true,
				disabled: true,
				hint: "A database needs at least one list",
				onClick: () => {},
			},
		]);

		const menu = document.querySelector<HTMLElement>(".bs-object-menu");
		// Icon rows render the shared glyph element (was label-only before).
		expect(menu?.querySelectorAll(".bs-object-menu__glyph")).toHaveLength(2);
		// A disabled row with a hint stays focusable and folds the reason into
		// its accessible name rather than going natively `disabled`.
		const del = menu?.querySelectorAll<HTMLButtonElement>(".bs-object-menu__item")[1];
		expect(del?.getAttribute("aria-disabled")).toBe("true");
		expect(del?.getAttribute("aria-label")).toBe("Delete, A database needs at least one list");
	});

	it("closeContextMenu removes the shared menu (delegates to closeAnchoredMenu)", () => {
		openContextMenu({ x: 0, y: 0 }, [{ label: "X", onClick: () => {} }]);
		expect(document.querySelector(".bs-object-menu")).not.toBeNull();
		closeContextMenu();
		expect(document.querySelector(".bs-object-menu")).toBeNull();
	});
});

describe("Database per-object stage menu is the shared object menu (B-1 parity)", () => {
	const APP_SRC = readFileSync(join(__dirname, "../app.ts"), "utf8");

	it("imports openObjectMenu from the shared SDK module (no forked popup)", () => {
		// Allow co-imports from the same module (e.g. `attachObjectMenuTrigger`
		// for the header subtitle's shared menu wiring) — only requirement
		// is that `openObjectMenu` itself comes from the shared SDK.
		expect(APP_SRC).toMatch(
			/import\s*\{[^}]*\bopenObjectMenu\b[^}]*\}\s*from\s*["']@brainstorm-os\/sdk\/object-menu["']/,
		);
	});

	it("binds ONE delegated contextmenu on the stable stage body across all view kinds", () => {
		expect(APP_SRC).toMatch(/getElementById\("stage-body"\)/);
		expect(APP_SRC).toMatch(/body\.addEventListener\("contextmenu"/);
		expect(APP_SRC).toMatch(/closest<HTMLElement>\("\[data-entity-id\]"\)/);
	});

	it("routes the per-object menu through openObjectMenu with the documented contract shape", () => {
		// DND-6 — the right-click listener and the Shift+F10 chord share ONE
		// builder (`openRowObjectMenu(state, entity, point)`), so the click point
		// flows through `point` rather than an inline `{x: event.clientX, …}`.
		expect(APP_SRC).toMatch(
			/openRowObjectMenu\(state,\s*entity,\s*\{\s*x:\s*event\.clientX,\s*y:\s*event\.clientY\s*\}\s*\)/,
		);
		expect(APP_SRC).toMatch(/openObjectMenu\(point,\s*\{/);
		expect(APP_SRC).toMatch(
			/target:\s*\{\s*entityId:\s*entity\.id,\s*entityType:\s*entity\.type\s*\}\s*,\s*runtime,/,
		);
	});

	it("DND-6 — the keyboard chord opens the same row menu for the selection anchor", () => {
		expect(APP_SRC).toMatch(/attachShortcut\(body,\s*"Shift\+F10"/);
		expect(APP_SRC).toMatch(/openRowObjectMenu\(state,\s*entity,\s*\{\s*x:\s*rect\.left/);
	});

	it("does NOT hand-roll the object menu via the private context-menu adapter", () => {
		const stageMenuBlock = APP_SRC.slice(
			APP_SRC.indexOf("function bindStageObjectMenu"),
			APP_SRC.indexOf("function selectList"),
		);
		expect(stageMenuBlock).not.toMatch(/openContextMenu\(/);
		expect(stageMenuBlock).toMatch(/openObjectMenu\(/);
	});
});

// @vitest-environment jsdom
/**
 * The object-menu RENDERER contract — `openObjectMenu` builds via the
 * headless `buildObjectMenuItems` and paints the shared glass popup. These
 * assertions are also Database's parity proof: Database used to hand-map
 * the same builder onto a private popup; the rendered DOM here is exactly
 * what its rows now produce (same items, order, destructive styling,
 * one-at-a-time, mousedown-outside + Escape close).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectMenuRuntime } from "./object-menu";
import { closeObjectMenu, openObjectMenu } from "./open-object-menu";

const runtime = (over: Partial<NonNullable<ObjectMenuRuntime>> = {}): ObjectMenuRuntime => ({
	capabilities: ["intents.dispatch:open", "dashboard.pin"],
	services: {
		intents: { dispatch: vi.fn() },
		dashboard: {
			pin: vi.fn(async () => true),
			unpin: vi.fn(async () => true),
			isPinned: vi.fn(async () => false),
		},
	},
	...over,
});

const target = { entityId: "ent-1", entityType: "io.acme/Doc/v1", label: "Spec" };

function menuEl(): HTMLElement | null {
	return document.querySelector<HTMLElement>(".bs-object-menu");
}
function rows(): HTMLButtonElement[] {
	return [...document.querySelectorAll<HTMLButtonElement>(".bs-object-menu__item")];
}

beforeEach(() => {
	vi.stubGlobal("innerWidth", 1024);
	vi.stubGlobal("innerHeight", 768);
});

afterEach(() => {
	closeObjectMenu();
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("openObjectMenu", () => {
	it("renders a role=menu glass popup with role=menuitem rows", async () => {
		await openObjectMenu({ x: 40, y: 40 }, { target, runtime: runtime() });
		const menu = menuEl();
		expect(menu).not.toBeNull();
		expect(menu?.getAttribute("role")).toBe("menu");
		expect(menu?.classList.contains("glass--strong")).toBe(true);
		expect(menu?.getAttribute("aria-label")).toBe("Object actions");
		expect(rows().every((b) => b.getAttribute("role") === "menuitem")).toBe(true);
	});

	it("Open is first; Pin shows when not pinned (the Database parity order)", async () => {
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: runtime() });
		expect(rows().map((b) => b.textContent)).toEqual(["Open", "Pin to dashboard"]);
	});

	it("pre-fetches pin state → labels Unpin without a flash", async () => {
		const rt = runtime({
			services: {
				dashboard: { isPinned: vi.fn(async () => true), unpin: vi.fn(async () => true) },
			},
		});
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: rt });
		expect(rows().map((b) => b.textContent)).toEqual(["Open", "Remove from dashboard"]);
	});

	it("pre-fetches open candidates → renders an 'Open with' row when 2+ apps claim it", async () => {
		const suggest = vi.fn(async () => [
			{ appId: "io.acme.books", label: "Books" },
			{ appId: "io.acme.preview", label: "Preview" },
		]);
		const rt = runtime({
			services: {
				intents: { dispatch: vi.fn(), suggest },
				dashboard: { isPinned: vi.fn(async () => false), pin: vi.fn(async () => true) },
			},
		});
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: rt });
		expect(suggest).toHaveBeenCalledWith({
			verb: "open",
			payload: { entityId: "ent-1", entityType: "io.acme/Doc/v1" },
		});
		expect(rows().map((b) => b.textContent)).toEqual(["Open", "Open with", "Pin to dashboard"]);
	});

	it("no 'Open with' row when only one app claims the object", async () => {
		const suggest = vi.fn(async () => [{ appId: "io.acme.books", label: "Books" }]);
		const rt = runtime({
			services: {
				intents: { dispatch: vi.fn(), suggest },
				dashboard: { isPinned: vi.fn(async () => false), pin: vi.fn(async () => true) },
			},
		});
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: rt });
		expect(rows().map((b) => b.textContent)).toEqual(["Open", "Pin to dashboard"]);
	});

	it("destructive Remove is last, glyph'd and data-destructive", async () => {
		const onRemove = vi.fn();
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: runtime(), onRemove });
		const last = rows().at(-1);
		expect(last?.textContent).toBe("Remove");
		expect(last?.dataset.destructive).toBe("true");
		expect(last?.querySelector(".bs-object-menu__glyph")).not.toBeNull();
		last?.click();
		expect(onRemove).toHaveBeenCalledOnce();
	});

	it("extra items splice before Remove (Print… parity)", async () => {
		const print = vi.fn();
		await openObjectMenu(
			{ x: 10, y: 10 },
			{
				target,
				runtime: runtime(),
				onRemove: vi.fn(),
				extraItems: [{ id: "print", label: "Print…", run: print }],
			},
		);
		expect(rows().map((b) => b.textContent)).toEqual([
			"Open",
			"Pin to dashboard",
			"Print…",
			"Remove",
		]);
	});

	it("fences the destructive Remove off with a divider above it", async () => {
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: runtime(), onRemove: vi.fn() });
		const sep = document.querySelector(".bs-object-menu__divider");
		expect(sep).not.toBeNull();
		// The divider sits between the safe rows and the destructive Remove.
		const kids = [...(menuEl()?.children ?? [])];
		const dividerIdx = kids.indexOf(sep as Element);
		const removeIdx = kids.findIndex((c) => c.textContent === "Remove");
		expect(dividerIdx).toBeGreaterThanOrEqual(0);
		expect(removeIdx).toBe(dividerIdx + 1);
	});

	it("no leading divider when Remove is the only row (omitOpen, no pin)", async () => {
		await openObjectMenu(
			{ x: 10, y: 10 },
			{ target, runtime: { services: {} }, omitOpen: true, onRemove: vi.fn() },
		);
		expect(rows().map((b) => b.textContent)).toEqual(["Remove"]);
		expect(document.querySelector(".bs-object-menu__divider")).toBeNull();
	});

	it("localised labels override item + chrome strings", async () => {
		await openObjectMenu(
			{ x: 10, y: 10 },
			{ target, runtime: runtime(), labels: { open: "Öffnen", menuRegion: "Aktionen" } },
		);
		expect(rows()[0]?.textContent).toBe("Öffnen");
		expect(menuEl()?.getAttribute("aria-label")).toBe("Aktionen");
	});

	it("selecting an item runs it then closes the menu", async () => {
		const rt = runtime();
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: rt });
		rows()
			.find((b) => b.textContent === "Pin to dashboard")
			?.click();
		expect(rt?.services?.dashboard?.pin).toHaveBeenCalledWith({ entityId: "ent-1" });
		expect(menuEl()).toBeNull();
	});

	it("only one menu open at a time", async () => {
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: runtime() });
		await openObjectMenu({ x: 20, y: 20 }, { target, runtime: runtime() });
		expect(document.querySelectorAll(".bs-object-menu")).toHaveLength(1);
	});

	it("mousedown outside closes", async () => {
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: runtime() });
		document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		expect(menuEl()).toBeNull();
	});

	it("Escape closes (via the B-2 chord matcher, not raw e.key)", async () => {
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: runtime() });
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(menuEl()).toBeNull();
	});

	it("clamps the menu into the viewport", async () => {
		await openObjectMenu({ x: 2000, y: 2000 }, { target, runtime: runtime() });
		const menu = menuEl();
		expect(Number.parseInt(menu?.style.left ?? "0", 10)).toBeLessThan(1024);
		expect(Number.parseInt(menu?.style.top ?? "0", 10)).toBeLessThan(768);
	});

	// The action surface (doc 63 / AS-1) — every object menu becomes
	// contribution-aware via openObjectMenu's `suggestActions` pass.
	const contributedRuntime = (
		actions: { verb: string; kind?: string; label: string; group: string; appId: string }[],
	): ObjectMenuRuntime => ({
		capabilities: ["intents.dispatch:open", "intents.dispatch:process"],
		services: {
			intents: {
				dispatch: vi.fn(),
				suggestActions: vi.fn(async () =>
					actions.map((a) => ({
						id: `${a.verb}:${a.kind ?? ""}:${a.appId}`,
						verb: a.verb as never,
						...(a.kind ? { kind: a.kind } : {}),
						label: a.label,
						group: a.group as never,
						priority: "secondary" as const,
						trustTier: "trusted" as never,
						appId: a.appId,
						appLabel: a.appId,
					})),
				),
			},
		},
	});

	it("splices contributed actions (with a group header) between built-ins and Remove", async () => {
		await openObjectMenu(
			{ x: 10, y: 10 },
			{
				target,
				runtime: contributedRuntime([
					{
						verb: "process",
						kind: "summarize",
						label: "Summarize",
						group: "actions",
						appId: "io.agent",
					},
				]),
				onRemove: () => {},
			},
		);
		const labels = rows().map((b) => b.textContent);
		expect(labels).toContain("Summarize");
		// Remove stays last (destructive).
		expect(labels[labels.length - 1]).toBe("Remove");
		// Contributed action sits before Remove.
		expect(labels.indexOf("Summarize")).toBeLessThan(labels.indexOf("Remove"));
	});

	it("does not splice anything when no contributions apply", async () => {
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: contributedRuntime([]) });
		// No dashboard surface in this runtime, so only Open shows — and crucially
		// no contributed rows / group headers are added.
		expect(rows().map((b) => b.textContent)).toEqual(["Open"]);
	});
});

describe("openObjectMenu — the read-only lock (Lock-5(c))", () => {
	it("renders the Lock row after Pin, and Unlock when locked", async () => {
		await openObjectMenu(
			{ x: 10, y: 10 },
			{ target, runtime: runtime(), locked: false, onToggleLock: () => undefined },
		);
		expect(rows().map((b) => b.textContent)).toEqual([
			"Open",
			"Pin to dashboard",
			"Lock (read-only)",
		]);
		closeObjectMenu();

		await openObjectMenu(
			{ x: 10, y: 10 },
			{ target, runtime: runtime(), locked: true, onToggleLock: () => undefined },
		);
		expect(rows().map((b) => b.textContent)).toContain("Unlock");
	});

	it("activating the row runs the app's toggle", async () => {
		const onToggleLock = vi.fn();
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: runtime(), onToggleLock });
		rows()
			.find((b) => b.textContent === "Lock (read-only)")
			?.click();
		expect(onToggleLock).toHaveBeenCalledTimes(1);
	});

	it("disables the RENDERER-owned Remove row on a locked object", async () => {
		// `openObjectMenu` paints Remove itself (so contributed actions can splice
		// in above it), which means the builder's lock gate does not reach it —
		// this is the assertion that keeps the two paths agreeing.
		await openObjectMenu(
			{ x: 10, y: 10 },
			{
				target,
				runtime: runtime(),
				locked: true,
				onToggleLock: () => undefined,
				onRemove: vi.fn(),
			},
		);
		const remove = rows().find((b) => b.textContent === "Remove");
		// The shared menu keeps a hinted-disabled row FOCUSABLE and folds the
		// reason into its accessible name, so keyboard + screen-reader users get
		// the explanation a native `disabled` button would swallow.
		expect(remove?.getAttribute("aria-disabled")).toBe("true");
		expect(remove?.getAttribute("aria-label")).toBe(
			"Remove, This object is locked — unlock it to make changes",
		);
		expect(remove?.title).toBe("This object is locked — unlock it to make changes");
	});

	it("a locked object's Remove does nothing when activated", async () => {
		const onRemove = vi.fn();
		await openObjectMenu(
			{ x: 10, y: 10 },
			{ target, runtime: runtime(), locked: true, onToggleLock: () => undefined, onRemove },
		);
		rows()
			.find((b) => b.textContent === "Remove")
			?.click();
		expect(onRemove).not.toHaveBeenCalled();
	});

	it("leaves Remove live on an unlocked object", async () => {
		const onRemove = vi.fn();
		await openObjectMenu({ x: 10, y: 10 }, { target, runtime: runtime(), onRemove });
		const remove = rows().find((b) => b.textContent === "Remove");
		expect(remove?.getAttribute("aria-disabled")).toBeNull();
		expect(remove?.disabled).toBe(false);
	});
});

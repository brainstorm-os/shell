import { ThemeName } from "@brainstorm-os/tokens";
import { describe, expect, it, vi } from "vitest";
import type { WebContentsViewHandle } from "../apps/window-container";
import type { WidgetPlacement } from "./widget-host";
import {
	WidgetHostController,
	type WidgetSession,
	placementsFromWidgets,
} from "./widget-host-controller";
import type { WidgetSpec, WidgetSurfaceDeps } from "./widget-surface-factory";

function makeView(id: number): WebContentsViewHandle {
	let closed = false;
	return {
		webContents: {
			id,
			send: () => {},
			getTitle: () => "",
			getURL: () => "",
			isDestroyed: () => closed,
			isFocused: () => false,
			startDrag: () => {},
			close: () => {
				closed = true;
			},
			focus: () => {},
			loadURL: () => {},
			on: () => {},
			off: () => {},
		},
		setBounds: () => {},
		setVisible: () => {},
		setBackgroundColor: () => {},
	};
}

function makeController(overrides: Partial<WidgetHostControllerDepsLike> = {}) {
	let nextId = 1;
	const created: number[] = [];
	const surfaceDeps: WidgetSurfaceDeps = {
		identities: {
			register: vi.fn(),
			unregister: vi.fn(),
		} as unknown as WidgetSurfaceDeps["identities"],
		getMountPoint: () => ({ addChildView: () => {}, removeChildView: () => {} }),
		createView: () => {
			const id = nextId++;
			created.push(id);
			return makeView(id);
		},
	};
	const resolve = vi.fn(
		async (placement: WidgetPlacement): Promise<WidgetSpec | null> => ({
			appId: placement.appId,
			entryUrl: `file:///${placement.id}`,
			preloadPath: "/p.js",
			additionalArguments: [],
			backgroundColor: "#000",
		}),
	);
	const session: WidgetSession = {
		dataStores: { open: async () => ({}) as never },
		capabilityLedger: async () => ({}) as never,
	};
	const controller = new WidgetHostController({
		surfaceDeps,
		preloadPath: "/p.js",
		getActiveSession: () => (overrides.session === null ? null : session),
		resolve,
	});
	return { controller, resolve, created, surfaceDeps };
}
type WidgetHostControllerDepsLike = { session: WidgetSession | null };

const A: WidgetPlacement = { id: "a", appId: "app.a", widgetId: "w" };
const B: WidgetPlacement = { id: "b", appId: "app.b", widgetId: "w" };

describe("placementsFromWidgets", () => {
	it("maps the snapshot widgets map to placements (kind → widgetId)", () => {
		expect(
			placementsFromWidgets({
				p1: { appId: "app.a", kind: "recent" },
				p2: { appId: "app.b", kind: "agenda" },
			}),
		).toEqual([
			{ id: "p1", appId: "app.a", widgetId: "recent" },
			{ id: "p2", appId: "app.b", widgetId: "agenda" },
		]);
	});
});

describe("WidgetHostController", () => {
	it("creates a surface per placement and destroys removed ones", async () => {
		const { controller, created } = makeController();
		await controller.reconcile([A, B]);
		expect(controller.size).toBe(2);
		expect(created).toEqual([1, 2]);
		await controller.reconcile([B]);
		expect(controller.size).toBe(1);
	});

	it("does not re-resolve an unchanged placement on a later reconcile", async () => {
		const { controller, resolve } = makeController();
		await controller.reconcile([A], { theme: ThemeName.Midnight });
		expect(resolve).toHaveBeenCalledTimes(1);
		// Theme-only snapshot: same target → no re-resolution, no churn.
		await controller.reconcile([A], { theme: ThemeName.Sepia });
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(controller.size).toBe(1);
	});

	it("re-resolves + recreates when a placement's target changes", async () => {
		const { controller, resolve, created } = makeController();
		await controller.reconcile([{ id: "x", appId: "app.a", widgetId: "w1" }]);
		await controller.reconcile([{ id: "x", appId: "app.a", widgetId: "w2" }]);
		expect(resolve).toHaveBeenCalledTimes(2);
		// Same id, different widget → destroyed + recreated (two distinct views).
		expect(created).toEqual([1, 2]);
		expect(controller.size).toBe(1);
	});

	it("tears everything down when no session is active", async () => {
		const { controller } = makeController({ session: null });
		await controller.reconcile([A, B]);
		expect(controller.size).toBe(0);
	});

	it("destroyForApp drops only that app's surfaces", async () => {
		const { controller } = makeController();
		await controller.reconcile([A, B]);
		controller.destroyForApp("app.a");
		expect(controller.size).toBe(1);
		// A re-placed widget for that app resolves fresh next reconcile.
		await controller.reconcile([A, B]);
		expect(controller.size).toBe(2);
	});

	it("destroyAll clears all surfaces + caches", async () => {
		const { controller } = makeController();
		await controller.reconcile([A, B]);
		controller.destroyAll();
		expect(controller.size).toBe(0);
	});
});

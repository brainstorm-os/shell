/**
 * The shared object-menu contract — same items, order, labels across
 * apps. Pure builder; the runtime is a structural stub.
 */

import { describe, expect, it, vi } from "vitest";
import { IconName } from "../icon/icon-registry";
import { type ObjectMenuRuntime, buildObjectMenuItems, isObjectPinned } from "./object-menu";

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

describe("buildObjectMenuItems", () => {
	it("Open is always first", () => {
		const items = buildObjectMenuItems({ target, runtime: runtime(), pinned: false });
		expect(items[0]?.id).toBe("open");
		expect(items[0]?.label).toBe("Open");
	});

	it("built-in items carry their glyphs (Open / Pin / Unpin / Remove)", () => {
		const pin = buildObjectMenuItems({ target, runtime: runtime(), pinned: false });
		expect(pin.find((i) => i.id === "open")?.icon).toBe(IconName.OpenExternal);
		expect(pin.find((i) => i.id === "pin")?.icon).toBe(IconName.Pin);

		const unpin = buildObjectMenuItems({ target, runtime: runtime(), pinned: true });
		expect(unpin.find((i) => i.id === "unpin")?.icon).toBe(IconName.PinSlash);

		const withRemove = buildObjectMenuItems({
			target,
			runtime: runtime(),
			pinned: false,
			onRemove: () => undefined,
		});
		expect(withRemove.find((i) => i.id === "remove")?.icon).toBe(IconName.Trash);
	});

	it("Open is enabled when the runtime can dispatch", () => {
		const items = buildObjectMenuItems({ target, runtime: runtime(), pinned: false });
		expect(items[0]?.disabled).toBeUndefined();
		expect(items[0]?.hint).toBeUndefined();
	});

	it("Open is disabled with a hint when the runtime cannot dispatch (standalone)", () => {
		const items = buildObjectMenuItems({
			target,
			runtime: runtime({ services: { intents: {} } }),
			pinned: false,
		});
		expect(items[0]?.id).toBe("open");
		expect(items[0]?.disabled).toBe(true);
		expect(items[0]?.hint).toBe("Running standalone — open this inside the shell to use it");
	});

	it("a localised openUnavailable hint overrides the English default", () => {
		const items = buildObjectMenuItems({
			target,
			runtime: runtime({ services: { intents: {} } }),
			pinned: false,
			labels: { openUnavailable: "Im Shell öffnen" },
		});
		expect(items[0]?.hint).toBe("Im Shell öffnen");
	});

	it("offers no Open-with item with zero or one candidate", () => {
		const none = buildObjectMenuItems({ target, runtime: runtime(), pinned: false });
		expect(none.some((i) => i.id === "open-with")).toBe(false);
		const one = buildObjectMenuItems({
			target,
			runtime: runtime(),
			pinned: false,
			openWithCandidates: [{ appId: "io.acme.books", label: "Books" }],
		});
		expect(one.some((i) => i.id === "open-with")).toBe(false);
	});

	it("adds an 'Open with ▸' cascade (after Open) with 2+ candidates", () => {
		const items = buildObjectMenuItems({
			target,
			runtime: runtime(),
			pinned: false,
			openWithCandidates: [
				{ appId: "io.acme.books", label: "Books" },
				{ appId: "io.acme.preview", label: "Preview" },
			],
		});
		expect(items[0]?.id).toBe("open");
		const openWith = items[1];
		expect(openWith?.id).toBe("open-with");
		expect(openWith?.label).toBe("Open with");
		expect(openWith?.submenu?.map((s) => s.label)).toEqual(["Books", "Preview"]);
	});

	it("a cascade child forces its app via handlerAppId on the open dispatch", () => {
		const dispatch = vi.fn();
		const items = buildObjectMenuItems({
			target,
			runtime: runtime({ services: { intents: { dispatch } } }),
			pinned: false,
			openWithCandidates: [
				{ appId: "io.acme.books", label: "Books" },
				{ appId: "io.acme.preview", label: "Preview" },
			],
		});
		const preview = items.find((i) => i.id === "open-with")?.submenu?.[1];
		preview?.run();
		expect(dispatch).toHaveBeenCalledWith({
			verb: "open",
			payload: {
				entityId: "ent-1",
				entityType: "io.acme/Doc/v1",
				handlerAppId: "io.acme.preview",
			},
		});
	});

	it("omitOpen suppresses the Open-with cascade too", () => {
		const items = buildObjectMenuItems({
			target,
			runtime: runtime(),
			pinned: false,
			omitOpen: true,
			openWithCandidates: [
				{ appId: "io.acme.books", label: "Books" },
				{ appId: "io.acme.preview", label: "Preview" },
			],
		});
		expect(items.some((i) => i.id === "open" || i.id === "open-with")).toBe(false);
	});

	it("offers Pin when not pinned, Unpin when pinned", () => {
		const pin = buildObjectMenuItems({ target, runtime: runtime(), pinned: false });
		expect(pin.map((i) => i.id)).toEqual(["open", "pin"]);
		expect(pin[1]?.label).toBe("Pin to dashboard");

		const unpin = buildObjectMenuItems({ target, runtime: runtime(), pinned: true });
		expect(unpin.map((i) => i.id)).toEqual(["open", "unpin"]);
		expect(unpin[1]?.label).toBe("Remove from dashboard");
	});

	it("hides the pin toggle without the dashboard.pin capability", () => {
		const items = buildObjectMenuItems({
			target,
			runtime: runtime({ capabilities: ["intents.dispatch:open"] }),
			pinned: false,
		});
		expect(items.map((i) => i.id)).toEqual(["open"]);
	});

	it("accepts a scoped dashboard.pin grant too", () => {
		const items = buildObjectMenuItems({
			target,
			runtime: runtime({ capabilities: ["dashboard.pin:io.acme"] }),
			pinned: false,
		});
		expect(items.some((i) => i.id === "pin")).toBe(true);
	});

	it("splices extra items before a destructive Remove", () => {
		const printRun = vi.fn();
		const removeRun = vi.fn();
		const items = buildObjectMenuItems({
			target,
			runtime: runtime(),
			pinned: false,
			extraItems: [{ id: "print", label: "Print…", run: printRun }],
			onRemove: removeRun,
		});
		expect(items.map((i) => i.id)).toEqual(["open", "pin", "print", "remove"]);
		const remove = items.find((i) => i.id === "remove");
		expect(remove?.destructive).toBe(true);
	});

	it("omits Remove when no onRemove is supplied", () => {
		const items = buildObjectMenuItems({ target, runtime: runtime(), pinned: false });
		expect(items.some((i) => i.id === "remove")).toBe(false);
	});

	it("shows Share (after Pin, before Remove) only with onShare AND the sharing.share cap", () => {
		const onShare = vi.fn();
		const shareRt = runtime({
			capabilities: ["intents.dispatch:open", "dashboard.pin", "sharing.share"],
		});
		const items = buildObjectMenuItems({
			target,
			runtime: shareRt,
			pinned: false,
			onShare,
			onRemove: () => undefined,
		});
		expect(items.map((i) => i.id)).toEqual(["open", "pin", "share", "remove"]);
		const share = items.find((i) => i.id === "share");
		expect(share?.icon).toBe(IconName.KindLink);
		share?.run();
		expect(onShare).toHaveBeenCalledOnce();
	});

	it("omits Share when the app lacks the sharing.share cap (even with onShare)", () => {
		const items = buildObjectMenuItems({
			target,
			runtime: runtime(),
			pinned: false,
			onShare: vi.fn(),
		});
		expect(items.some((i) => i.id === "share")).toBe(false);
	});

	it("omits Share when no onShare is supplied (even with the cap)", () => {
		const shareRt = runtime({ capabilities: ["intents.dispatch:open", "sharing.share"] });
		const items = buildObjectMenuItems({ target, runtime: shareRt, pinned: false });
		expect(items.some((i) => i.id === "share")).toBe(false);
	});

	it("drops the leading Open when omitOpen is set (self-targeting header ⋯)", () => {
		const items = buildObjectMenuItems({
			target,
			runtime: runtime(),
			pinned: false,
			omitOpen: true,
			onRemove: () => undefined,
		});
		expect(items.some((i) => i.id === "open")).toBe(false);
		expect(items.map((i) => i.id)).toEqual(["pin", "remove"]);
	});

	it("localised labels override the English defaults", () => {
		const items = buildObjectMenuItems({
			target,
			runtime: runtime(),
			pinned: true,
			labels: { unpin: "Vom Dashboard lösen" },
		});
		expect(items.find((i) => i.id === "unpin")?.label).toBe("Vom Dashboard lösen");
	});

	it("pin item invokes the dashboard pin surface with the entity id", async () => {
		const rt = runtime();
		const items = buildObjectMenuItems({ target, runtime: rt, pinned: false });
		await items.find((i) => i.id === "pin")?.run();
		expect(rt?.services?.dashboard?.pin).toHaveBeenCalledWith({ entityId: "ent-1" });
	});

	// Lock-5(c) — the lock's discoverability problem: it lived only in a header
	// button, in the seven apps that had one. The ⋯ menu is the ONE identical
	// surface fleet-wide, so the toggle belongs here too.
	describe("Lock / Unlock", () => {
		it("is absent when the app passes no lock handler (a surface with no lock concept)", () => {
			const items = buildObjectMenuItems({ target, runtime: runtime(), pinned: false });
			expect(items.some((i) => i.id === "lock" || i.id === "unlock")).toBe(false);
		});

		it("offers Lock on an unlocked object", () => {
			const items = buildObjectMenuItems({
				target,
				runtime: runtime(),
				pinned: false,
				locked: false,
				onToggleLock: () => undefined,
			});
			const lock = items.find((i) => i.id === "lock");
			expect(lock?.label).toBe("Lock (read-only)");
			expect(lock?.icon).toBe(IconName.Lock);
			expect(items.some((i) => i.id === "unlock")).toBe(false);
		});

		it("offers Unlock on a locked object", () => {
			const items = buildObjectMenuItems({
				target,
				runtime: runtime(),
				pinned: false,
				locked: true,
				onToggleLock: () => undefined,
			});
			expect(items.find((i) => i.id === "unlock")?.label).toBe("Unlock");
			expect(items.some((i) => i.id === "lock")).toBe(false);
		});

		it("sits after Pin and before Remove, so destructive stays last", () => {
			const items = buildObjectMenuItems({
				target,
				runtime: runtime(),
				pinned: false,
				locked: false,
				onToggleLock: () => undefined,
				onRemove: () => undefined,
			});
			expect(items.map((i) => i.id)).toEqual(["open", "pin", "lock", "remove"]);
		});

		it("runs the app's toggle handler", async () => {
			const onToggleLock = vi.fn();
			const items = buildObjectMenuItems({
				target,
				runtime: runtime(),
				pinned: false,
				locked: true,
				onToggleLock,
			});
			await items.find((i) => i.id === "unlock")?.run();
			expect(onToggleLock).toHaveBeenCalledTimes(1);
		});

		it("takes localised labels", () => {
			const items = buildObjectMenuItems({
				target,
				runtime: runtime(),
				pinned: false,
				locked: false,
				onToggleLock: () => undefined,
				labels: { lock: "Sperren (schreibgeschützt)" },
			});
			expect(items.find((i) => i.id === "lock")?.label).toBe("Sperren (schreibgeschützt)");
		});

		// The lock gates the app's OWN write paths; Remove is one of them. A menu
		// that offers "Remove" on a locked object is offering a write the app is
		// supposed to refuse — so the row is disabled with the reason, never
		// hidden (the vanishing-control anti-pattern, per the panel-toggle rule).
		it("disables Remove with a hint while the object is locked", () => {
			const items = buildObjectMenuItems({
				target,
				runtime: runtime(),
				pinned: false,
				locked: true,
				onToggleLock: () => undefined,
				onRemove: () => undefined,
			});
			const remove = items.find((i) => i.id === "remove");
			expect(remove?.disabled).toBe(true);
			expect(remove?.hint).toBe("This object is locked — unlock it to make changes");
		});

		it("disables a locked object's app-supplied write extras, leaving read-only ones alone", () => {
			const items = buildObjectMenuItems({
				target,
				runtime: runtime(),
				pinned: false,
				locked: true,
				onToggleLock: () => undefined,
				extraItems: [
					{ id: "rename", label: "Rename…", writes: true, run: () => undefined },
					{ id: "export", label: "Export…", run: () => undefined },
				],
			});
			expect(items.find((i) => i.id === "rename")?.disabled).toBe(true);
			expect(items.find((i) => i.id === "rename")?.hint).toBe(
				"This object is locked — unlock it to make changes",
			);
			expect(items.find((i) => i.id === "export")?.disabled).toBeUndefined();
		});

		it("leaves write extras alone when the object is unlocked", () => {
			const items = buildObjectMenuItems({
				target,
				runtime: runtime(),
				pinned: false,
				locked: false,
				onToggleLock: () => undefined,
				extraItems: [{ id: "rename", label: "Rename…", writes: true, run: () => undefined }],
				onRemove: () => undefined,
			});
			expect(items.find((i) => i.id === "rename")?.disabled).toBeUndefined();
			expect(items.find((i) => i.id === "remove")?.disabled).toBeUndefined();
		});
	});
});

describe("isObjectPinned", () => {
	it("passes through the surface result", async () => {
		const rt = runtime({
			services: { dashboard: { isPinned: vi.fn(async () => true) } },
		});
		expect(await isObjectPinned(rt, "ent-1")).toBe(true);
	});

	it("resolves false on a missing surface or a throw (safe default → Pin)", async () => {
		expect(await isObjectPinned(null, "ent-1")).toBe(false);
		expect(await isObjectPinned({ services: {} }, "ent-1")).toBe(false);
		const throwing = {
			services: {
				dashboard: {
					isPinned: vi.fn(async () => {
						throw new Error("denied");
					}),
				},
			},
		};
		expect(await isObjectPinned(throwing, "ent-1")).toBe(false);
	});
});

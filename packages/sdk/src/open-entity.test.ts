import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NavigationMode,
	moveEntity,
	navModeFromEvent,
	openEntity,
	quickLookEntity,
} from "./open-entity";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openEntity / quickLookEntity", () => {
	it("dispatches verb `open` via services.intents.dispatch with a typed payload", async () => {
		const dispatch = vi.fn(async () => undefined);
		const ok = await openEntity(
			{ services: { intents: { dispatch } } },
			{ entityId: "ent_1", entityType: "io.x/Note/v1" },
		);
		expect(ok).toBe(true);
		expect(dispatch).toHaveBeenCalledWith({
			verb: "open",
			payload: { entityId: "ent_1", entityType: "io.x/Note/v1" },
		});
	});

	it("falls back to the thinner `intents.dispatch` runtime shape", async () => {
		const dispatch = vi.fn(async () => undefined);
		await openEntity({ intents: { dispatch } }, { entityId: "ent_2" });
		expect(dispatch).toHaveBeenCalledWith({ verb: "open", payload: { entityId: "ent_2" } });
	});

	it("omits entityType when not supplied and the id always wins over extra payload", async () => {
		const dispatch = vi.fn(async () => undefined);
		await openEntity(
			{ services: { intents: { dispatch } } },
			{ entityId: "real", payload: { entityId: "spoofed", context: { kind: "folder" } } },
		);
		expect(dispatch).toHaveBeenCalledWith({
			verb: "open",
			payload: { context: { kind: "folder" }, entityId: "real" },
		});
	});

	it("stamps handlerAppId into the payload (Open with…)", async () => {
		const dispatch = vi.fn(async () => undefined);
		await openEntity(
			{ services: { intents: { dispatch } } },
			{ entityId: "ent_1", entityType: "io.x/File/v1", handlerAppId: "io.x.preview" },
		);
		expect(dispatch).toHaveBeenCalledWith({
			verb: "open",
			payload: {
				entityId: "ent_1",
				entityType: "io.x/File/v1",
				handlerAppId: "io.x.preview",
			},
		});
	});

	it("returns false (no throw) when no dispatcher is reachable", async () => {
		expect(await openEntity(null, { entityId: "x" })).toBe(false);
		expect(await openEntity({}, { entityId: "x" })).toBe(false);
		expect(await openEntity({ services: { intents: null } }, { entityId: "x" })).toBe(false);
	});

	it("returns false for an empty entity id", async () => {
		const dispatch = vi.fn(async () => undefined);
		expect(await openEntity({ intents: { dispatch } }, { entityId: "" })).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("swallows a throwing dispatcher and returns false", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const dispatch = vi.fn(async () => {
			throw new Error("broker down");
		});
		expect(await openEntity({ intents: { dispatch } }, { entityId: "x" })).toBe(false);
	});

	it("quickLookEntity dispatches the `quick-look` verb", async () => {
		const dispatch = vi.fn(async () => undefined);
		await quickLookEntity({ intents: { dispatch } }, { entityId: "ent_9" });
		expect(dispatch).toHaveBeenCalledWith({
			verb: "quick-look",
			payload: { entityId: "ent_9" },
		});
	});
});

describe("moveEntity (9.8.7 — intent.move)", () => {
	it("dispatches verb `move` with entityIds + toFolderId + fromFolderId", async () => {
		const dispatch = vi.fn(async () => undefined);
		const ok = await moveEntity(
			{ services: { intents: { dispatch } } },
			{ entityIds: ["a", "b"], fromFolderId: "src", toFolderId: "dst" },
		);
		expect(ok).toBe(true);
		expect(dispatch).toHaveBeenCalledWith({
			verb: "move",
			payload: { entityIds: ["a", "b"], toFolderId: "dst", fromFolderId: "src" },
		});
	});

	it("sets copy: true and omits fromFolderId when copy is requested", async () => {
		const dispatch = vi.fn(async () => undefined);
		await moveEntity(
			{ services: { intents: { dispatch } } },
			{ entityIds: ["a"], toFolderId: "dst", copy: true },
		);
		expect(dispatch).toHaveBeenCalledWith({
			verb: "move",
			payload: { entityIds: ["a"], toFolderId: "dst", copy: true },
		});
	});

	it("omits the copy field when copy is omitted or falsy", async () => {
		const dispatch = vi.fn(async () => undefined);
		await moveEntity({ intents: { dispatch } }, { entityIds: ["x"], toFolderId: "d", copy: false });
		expect(dispatch).toHaveBeenCalledWith({
			verb: "move",
			payload: { entityIds: ["x"], toFolderId: "d" },
		});
	});

	it("returns false (no throw) when no dispatcher is reachable", async () => {
		expect(await moveEntity(null, { entityIds: ["a"], toFolderId: "d" })).toBe(false);
		expect(await moveEntity({}, { entityIds: ["a"], toFolderId: "d" })).toBe(false);
	});

	it("returns false on empty entityIds or empty toFolderId", async () => {
		const dispatch = vi.fn(async () => undefined);
		expect(await moveEntity({ intents: { dispatch } }, { entityIds: [], toFolderId: "d" })).toBe(
			false,
		);
		expect(await moveEntity({ intents: { dispatch } }, { entityIds: ["a"], toFolderId: "" })).toBe(
			false,
		);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("swallows a throwing dispatcher and returns false", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const dispatch = vi.fn(async () => {
			throw new Error("broker down");
		});
		expect(await moveEntity({ intents: { dispatch } }, { entityIds: ["a"], toFolderId: "d" })).toBe(
			false,
		);
	});

	it("clones entityIds so the dispatched payload does not alias the caller's array", async () => {
		let received: { verb: string; payload: Record<string, unknown> } | null = null;
		const dispatch = (req: { verb: string; payload: Record<string, unknown> }) => {
			received = req;
		};
		const ids = ["a", "b"];
		await moveEntity({ intents: { dispatch } }, { entityIds: ids, toFolderId: "d" });
		const payload = (received as { payload: { entityIds: string[] } } | null)?.payload;
		expect(payload?.entityIds).toEqual(ids);
		expect(payload?.entityIds).not.toBe(ids);
	});
});

describe("navModeFromEvent", () => {
	it("maps modifiers to the browser-identical modes", () => {
		expect(navModeFromEvent(null)).toBe(NavigationMode.Replace);
		expect(navModeFromEvent({})).toBe(NavigationMode.Replace);
		expect(navModeFromEvent({ metaKey: true })).toBe(NavigationMode.NewTab);
		expect(navModeFromEvent({ button: 1 })).toBe(NavigationMode.NewTab);
		expect(navModeFromEvent({ shiftKey: true })).toBe(NavigationMode.NewWindow);
	});

	it("Alt+click opens beside the current pane (6.14 / doc 37 new-panel)", () => {
		expect(navModeFromEvent({ altKey: true })).toBe(NavigationMode.NewPanel);
		// Alt beats Cmd/Ctrl (a deliberate panel), Shift still means a window.
		expect(navModeFromEvent({ metaKey: true, altKey: true })).toBe(NavigationMode.NewPanel);
		expect(navModeFromEvent({ shiftKey: true, altKey: true })).toBe(NavigationMode.NewWindow);
	});
});

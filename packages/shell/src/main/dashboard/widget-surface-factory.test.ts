import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeHandshake } from "@brainstorm-os/sdk";
import { ThemeName } from "@brainstorm-os/tokens";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebContentsViewHandle } from "../apps/window-container";
import type { WidgetPlacement } from "./widget-host";
import {
	type ChildViewMount,
	type WidgetSurfaceDeps,
	buildWidgetSpec,
	createWidgetSurface,
	resolveEntryPathSync,
} from "./widget-surface-factory";

const placement: WidgetPlacement = {
	id: "w1",
	appId: "io.brainstorm.notes",
	widgetId: "recent",
	bind: "ent_42",
};
const record = {
	version: "1.2.3",
	sdk: "1",
	bundleDir: "/vault/apps/notes",
	bundleSha256: "abcdef0123456789",
};

describe("buildWidgetSpec", () => {
	it("assembles a widget-mode handshake with caps, bind, theme + locale", () => {
		const spec = buildWidgetSpec({
			placement,
			record,
			capabilities: ["storage.kv", "entities.read:*"],
			entryPath: "dist/index.html",
			preloadPath: "/app-preload.js",
			theme: ThemeName.Midnight,
			locale: "fr-FR",
		});
		expect(spec.appId).toBe("io.brainstorm.notes");
		expect(spec.preloadPath).toBe("/app-preload.js");
		expect(spec.entryUrl).toBe("file:///vault/apps/notes/dist/index.html?v=abcdef01");

		const idArg = spec.additionalArguments.find((a) => a.startsWith("--brainstorm-app-id="));
		expect(idArg).toBe("--brainstorm-app-id=io.brainstorm.notes");
		expect(spec.additionalArguments).toContain("--brainstorm-build=abcdef01");
		expect(spec.additionalArguments).toContain(`--brainstorm-theme=${ThemeName.Midnight}`);

		const hsArg = spec.additionalArguments.find((a) => a.startsWith("--brainstorm-handshake="));
		const handshake = decodeHandshake((hsArg ?? "").slice("--brainstorm-handshake=".length));
		expect(handshake.app).toEqual({ id: "io.brainstorm.notes", version: "1.2.3", sdkVersion: "1" });
		expect(handshake.capabilities).toEqual(["storage.kv", "entities.read:*"]);
		expect(handshake.launch).toEqual({ reason: "widget", widgetId: "recent", bind: "ent_42" });
		expect(handshake.locale).toBe("fr-FR");
	});

	it("omits bind + theme arg when absent", () => {
		const spec = buildWidgetSpec({
			placement: { id: "w2", appId: "a", widgetId: "agenda" },
			record,
			capabilities: [],
			entryPath: "index.html",
			preloadPath: "/p.js",
		});
		expect(spec.additionalArguments.some((a) => a.startsWith("--brainstorm-theme="))).toBe(false);
		const hsArg = spec.additionalArguments.find((a) => a.startsWith("--brainstorm-handshake="));
		const handshake = decodeHandshake((hsArg ?? "").slice("--brainstorm-handshake=".length));
		expect(handshake.launch).toEqual({ reason: "widget", widgetId: "agenda" });
	});
});

describe("resolveEntryPathSync", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bs-widget-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads + caches manifest.entry by sha", () => {
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ entry: "dist/app.html" }));
		const cache = new Map<string, string>();
		expect(resolveEntryPathSync(dir, "sha1", cache)).toBe("dist/app.html");
		expect(cache.get("sha1")).toBe("dist/app.html");
		// Second call hits the cache (delete the file to prove no re-read).
		rmSync(join(dir, "manifest.json"));
		expect(resolveEntryPathSync(dir, "sha1", cache)).toBe("dist/app.html");
	});

	it("defaults to index.html when entry is absent", () => {
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "x" }));
		expect(resolveEntryPathSync(dir, "s", new Map())).toBe("index.html");
	});

	it("rejects a path that escapes the bundle", () => {
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ entry: "../../etc/passwd" }));
		expect(() => resolveEntryPathSync(dir, "s", new Map())).toThrow(/relative path/);
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ entry: "/abs" }));
		expect(() => resolveEntryPathSync(dir, "s2", new Map())).toThrow(/relative path/);
	});
});

type FakeView = WebContentsViewHandle & {
	bounds: { x: number; y: number; width: number; height: number } | null;
	visible: boolean;
	closed: boolean;
	loaded: string | null;
	sent: Array<{ channel: string; args: unknown[] }>;
};

function makeFakeView(id: number): FakeView {
	const view: FakeView = {
		bounds: null,
		visible: true,
		closed: false,
		loaded: null,
		sent: [],
		webContents: {
			id,
			send: (channel: string, ...args: unknown[]) => view.sent.push({ channel, args }),
			getTitle: () => "",
			getURL: () => "",
			isDestroyed: () => view.closed,
			isFocused: () => false,
			startDrag: () => {},
			close: () => {
				view.closed = true;
			},
			focus: () => {},
			loadURL: (url: string) => {
				view.loaded = url;
			},
			on: () => {},
			off: () => {},
		},
		setBounds: (b) => {
			view.bounds = b;
		},
		setVisible: (v) => {
			view.visible = v;
		},
		setBackgroundColor: () => {},
	};
	return view;
}

function makeDeps() {
	const views: FakeView[] = [];
	const mount: ChildViewMount & {
		added: WebContentsViewHandle[];
		removed: WebContentsViewHandle[];
	} = {
		added: [],
		removed: [],
		addChildView: (v) => mount.added.push(v),
		removeChildView: (v) => mount.removed.push(v),
	};
	const registered = new Map<number, string>();
	let nextId = 100;
	const deps: WidgetSurfaceDeps = {
		identities: {
			register: (wcId: number, appId: string) => registered.set(wcId, appId),
			unregister: (wcId: number) => registered.delete(wcId),
		} as unknown as WidgetSurfaceDeps["identities"],
		getMountPoint: () => mount,
		createView: () => {
			const v = makeFakeView(nextId++);
			views.push(v);
			return v;
		},
	};
	return { deps, views, mount, registered };
}

const spec = {
	appId: "io.brainstorm.notes",
	entryUrl: "file:///x/index.html?v=abc",
	preloadPath: "/p.js",
	additionalArguments: [],
	backgroundColor: "#101010",
};

describe("createWidgetSurface", () => {
	it("parents the view hidden, registers identity, loads the entry", () => {
		const { deps, views, mount, registered } = makeDeps();
		const surface = createWidgetSurface(spec, deps);
		expect(surface).not.toBeNull();
		const view = views[0];
		if (!view || !surface) throw new Error("no surface");
		expect(mount.added).toContain(view);
		expect(view.visible).toBe(false);
		expect(view.loaded).toBe("file:///x/index.html?v=abc");
		expect(registered.get(view.webContents.id)).toBe("io.brainstorm.notes");
		expect(surface.webContentsId).toBe(view.webContents.id);
	});

	it("rounds reported bounds to integers", () => {
		const { deps, views } = makeDeps();
		const surface = createWidgetSurface(spec, deps);
		surface?.setBounds({ x: 10.4, y: 20.6, width: 99.5, height: -3 });
		expect(views[0]?.bounds).toEqual({ x: 10, y: 21, width: 100, height: 0 });
	});

	it("sends the host-driven visibility signal on the shared channel", () => {
		const { deps, views } = makeDeps();
		const surface = createWidgetSurface(spec, deps);
		surface?.sendVisibility(false);
		expect(views[0]?.sent).toEqual([{ channel: "window:visibility-changed", args: [false] }]);
	});

	it("destroy unregisters, detaches, closes — and is idempotent", () => {
		const { deps, views, mount, registered } = makeDeps();
		const surface = createWidgetSurface(spec, deps);
		const view = views[0];
		if (!view || !surface) throw new Error("no surface");
		surface.destroy();
		expect(registered.has(view.webContents.id)).toBe(false);
		expect(mount.removed).toContain(view);
		expect(view.closed).toBe(true);
		surface.destroy(); // no throw, no double-close side effects
		expect(mount.removed.length).toBe(1);
	});

	it("returns null when there is no dashboard window to host it", () => {
		const { deps } = makeDeps();
		const noMount: WidgetSurfaceDeps = { ...deps, getMountPoint: () => null };
		expect(createWidgetSurface(spec, noMount)).toBeNull();
	});
});

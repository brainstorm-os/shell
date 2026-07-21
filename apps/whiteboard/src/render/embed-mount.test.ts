// @vitest-environment jsdom

import { BlockFramePhase } from "@brainstorm-os/sdk/block-frame";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EmbedMountController,
	EmbedMountRegistry,
	embedCandidates,
	embedEntityLabel,
	parseEmbedRef,
	resolveEmbedBlockId,
} from "./embed-mount";

// ── Fakes for the SDK block-frame observers (jsdom has neither natively) ─────

interface FakeIntersection {
	fire(entries: Array<Partial<IntersectionObserverEntry>>): void;
}
let lastIntersection: FakeIntersection | null = null;

class FakeIntersectionObserver implements FakeIntersection {
	private cb: IntersectionObserverCallback;
	constructor(cb: IntersectionObserverCallback) {
		this.cb = cb;
		lastIntersection = this;
	}
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
	takeRecords(): IntersectionObserverEntry[] {
		return [];
	}
	root: Element | null = null;
	rootMargin = "";
	thresholds: readonly number[] = [];
	fire(entries: Array<Partial<IntersectionObserverEntry>>): void {
		this.cb(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
	}
}

class FakeResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

function fakeHost(): Pick<Window, "addEventListener" | "removeEventListener"> & {
	fire(type: string, event: Event): void;
} {
	const listeners = new Map<string, Set<EventListener>>();
	return {
		addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
			let set = listeners.get(type);
			if (!set) {
				set = new Set();
				listeners.set(type, set);
			}
			set.add(listener as EventListener);
		},
		removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
			listeners.get(type)?.delete(listener as EventListener);
		},
		fire(type: string, event: Event) {
			for (const l of listeners.get(type) ?? []) l(event);
		},
	};
}

const REF = "brainstorm://entity/task-1";

afterEach(() => {
	document.body.replaceChildren();
	lastIntersection = null;
	vi.restoreAllMocks();
});

describe("parseEmbedRef", () => {
	it("extracts the entity id from a brainstorm entity uri", () => {
		expect(parseEmbedRef(REF)).toEqual({ entityId: "task-1" });
	});

	it("carries an explicit #block-<id> fragment through", () => {
		expect(parseEmbedRef("brainstorm://entity/x#block-io.brainstorm.tasks/task")).toEqual({
			entityId: "x",
			blockId: "io.brainstorm.tasks/task",
		});
	});

	it("returns null for a non-entity / external uri", () => {
		expect(parseEmbedRef("https://example.com")).toBeNull();
		expect(parseEmbedRef("brainstorm://entity/")).toBeNull();
	});
});

describe("resolveEmbedBlockId", () => {
	it("prefers an explicit block id without touching the registry", async () => {
		const forType = vi.fn();
		expect(await resolveEmbedBlockId("explicit/block", "T", { forType })).toBe("explicit/block");
		expect(forType).not.toHaveBeenCalled();
	});

	it("resolves via the registry from the entity type", async () => {
		const forType = vi.fn().mockResolvedValue("io.brainstorm.tasks/task");
		expect(await resolveEmbedBlockId(undefined, "Task/v1", { forType })).toBe(
			"io.brainstorm.tasks/task",
		);
		expect(forType).toHaveBeenCalledWith("Task/v1");
	});

	it("returns null when no provider claims the type, or the registry throws", async () => {
		expect(await resolveEmbedBlockId(undefined, "T", { forType: async () => null })).toBeNull();
		expect(await resolveEmbedBlockId(undefined, "T", { forType: async () => "" })).toBeNull();
		expect(
			await resolveEmbedBlockId(undefined, "T", {
				forType: async () => {
					throw new Error("broker down");
				},
			}),
		).toBeNull();
	});

	it("returns null when no type and no explicit id are available", async () => {
		expect(await resolveEmbedBlockId(undefined, undefined, undefined)).toBeNull();
	});
});

describe("embedCandidates", () => {
	const ent = (id: string, props: Record<string, unknown>, deletedAt: number | null = null) => ({
		id,
		type: "Note/v1",
		properties: props,
		deletedAt,
	});

	it("labels from name / title / label, falling back to the id", () => {
		expect(embedEntityLabel(ent("a", { name: "Alpha" }))).toBe("Alpha");
		expect(embedEntityLabel(ent("b", { title: "Beta" }))).toBe("Beta");
		expect(embedEntityLabel(ent("c", { label: "Gamma" }))).toBe("Gamma");
		expect(embedEntityLabel(ent("d", {}))).toBe("d");
		expect(embedEntityLabel(ent("e", { name: "   " }))).toBe("e");
	});

	it("excludes deleted entities and the embedding board itself, sorted by label", () => {
		const out = embedCandidates(
			[
				ent("board-1", { name: "Self" }),
				ent("z", { name: "Zebra" }),
				ent("a", { name: "Apple" }),
				ent("gone", { name: "Gone" }, 123),
			],
			"board-1",
		);
		expect(out.map((c) => c.label)).toEqual(["Apple", "Zebra"]);
		expect(out.map((c) => c.id)).toEqual(["a", "z"]);
	});
});

function makeServices(over: {
	forType?: (t: string) => Promise<string | null>;
	source?: (id: string) => Promise<string | null>;
	dispatch?: (entityId: string, m: unknown) => Promise<unknown>;
}) {
	return {
		blocks: {
			forType: over.forType ?? (async () => "io.brainstorm.tasks/task"),
			source: over.source ?? (async () => "/* block bundle */"),
		},
		...(over.dispatch ? { bp: { dispatch: over.dispatch } } : {}),
	};
}

function controllerOptions(extra: Partial<Parameters<typeof EmbedMountController.create>[0]> = {}) {
	const navigate = vi.fn();
	const resize = vi.fn();
	const host = fakeHost();
	return {
		navigate,
		resize,
		host,
		opts: {
			entityRef: REF,
			entityType: "Task/v1",
			services: makeServices({}),
			callbacks: { navigate, resize },
			title: "Embedded entity",
			injection: {
				IntersectionObserverImpl: FakeIntersectionObserver as unknown as typeof IntersectionObserver,
				ResizeObserverImpl: FakeResizeObserver as unknown as typeof ResizeObserver,
				mintChannelId: () => "test-chan",
				host,
				collectTheme: () => ({ vars: { "--color-bg": "#000" }, colorScheme: "dark" }),
			},
			...extra,
		},
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("EmbedMountController", () => {
	it("returns null for a malformed entity ref (caller paints the fallback)", () => {
		const { opts } = controllerOptions({ entityRef: "https://nope" });
		expect(EmbedMountController.create(opts)).toBeNull();
	});

	it("mounts the providing block bundle through the loader once resolved", async () => {
		const { opts } = controllerOptions();
		const controller = EmbedMountController.create(opts);
		expect(controller).not.toBeNull();
		document.body.appendChild(controller?.container as Node);
		await flushMicrotasks();
		const iframe = controller?.container.querySelector("iframe");
		expect(iframe).not.toBeNull();
		// The 9.5.1 pinned security attributes come from the SDK, not us.
		expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
		expect(controller?.container.dataset.embedState).toBe("live");
		controller?.dispose();
	});

	it("does not mount an iframe when no provider claims the type", async () => {
		const { opts } = controllerOptions();
		opts.services = makeServices({ forType: async () => null });
		const controller = EmbedMountController.create(opts);
		await flushMicrotasks();
		expect(controller?.container.querySelector("iframe")).toBeNull();
		expect(controller?.container.dataset.embedState).toBe("no-provider");
	});

	it("does not mount when the provider ships no bundle source", async () => {
		const { opts } = controllerOptions();
		opts.services = makeServices({ source: async () => null });
		const controller = EmbedMountController.create(opts);
		await flushMicrotasks();
		expect(controller?.container.querySelector("iframe")).toBeNull();
		expect(controller?.container.dataset.embedState).toBe("no-bundle");
	});

	it("flushes Startup over the loader once the IntersectionObserver fires Mounted", async () => {
		const { opts } = controllerOptions();
		const controller = EmbedMountController.create(opts);
		document.body.appendChild(controller?.container as Node);
		await flushMicrotasks();
		const iframe = controller?.container.querySelector("iframe");
		const win = iframe?.contentWindow;
		if (!win) throw new Error("no contentWindow");
		const postSpy = vi.spyOn(win, "postMessage");
		lastIntersection?.fire([{ isIntersecting: true }]);
		const calls = postSpy.mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const env = calls[0]?.[0] as { channelId: string; entityId: string; kind: string };
		expect(env.channelId).toBe("test-chan");
		expect(env.entityId).toBe("task-1");
		expect(env.kind).toBe("startup");
		controller?.dispose();
	});

	it("forwards a block `navigate` message to the open callback", async () => {
		const { opts, navigate, host } = controllerOptions();
		const controller = EmbedMountController.create(opts);
		document.body.appendChild(controller?.container as Node);
		await flushMicrotasks();
		lastIntersection?.fire([{ isIntersecting: true }]);
		// Simulate the block posting a navigate control message back over the
		// transport (the transport gates on channel id + the iframe source).
		const iframe = controller?.container.querySelector("iframe") as HTMLIFrameElement;
		host.fire(
			"message",
			new MessageEvent("message", {
				source: iframe.contentWindow,
				data: {
					v: 1,
					channelId: "test-chan",
					entityId: "task-1",
					direction: "block-to-host",
					kind: "message",
					payload: { kind: "navigate", entityId: "other", entityType: "Note/v1" },
				},
			}),
		);
		expect(navigate).toHaveBeenCalledWith("other", "Note/v1");
		controller?.dispose();
	});

	it("dispose is idempotent and tears the frame down", async () => {
		const { opts } = controllerOptions();
		const controller = EmbedMountController.create(opts);
		document.body.appendChild(controller?.container as Node);
		await flushMicrotasks();
		controller?.dispose();
		controller?.dispose();
		// After dispose the frame is gone; a late resolution can't resurrect it.
		expect(controller?.container.querySelector("iframe")).toBeNull();
	});

	it("aborts the mount if disposed before resolution completes", async () => {
		const { opts } = controllerOptions();
		const release: { fn: ((v: string | null) => void) | null } = { fn: null };
		opts.services = makeServices({
			source: () =>
				new Promise<string | null>((r) => {
					release.fn = r;
				}),
		});
		const controller = EmbedMountController.create(opts);
		controller?.dispose();
		release.fn?.("/* bundle */");
		await flushMicrotasks();
		expect(controller?.container.querySelector("iframe")).toBeNull();
	});
});

describe("EmbedMountRegistry", () => {
	const liveOpts = () => controllerOptions().opts;

	it("reuses one controller per node id across repaints", async () => {
		const reg = new EmbedMountRegistry();
		const a = reg.acquire("n1", () => EmbedMountController.create(liveOpts()), REF);
		const b = reg.acquire("n1", () => EmbedMountController.create(liveOpts()), REF);
		expect(a).toBe(b);
		reg.disposeAll();
	});

	it("remounts when the entity ref changes", () => {
		const reg = new EmbedMountRegistry();
		const a = reg.acquire("n1", () => EmbedMountController.create(liveOpts()), REF);
		const disposeSpy = vi.spyOn(a as EmbedMountController, "dispose");
		const b = reg.acquire(
			"n1",
			() => EmbedMountController.create({ ...liveOpts(), entityRef: "brainstorm://entity/n2" }),
			"brainstorm://entity/n2",
		);
		expect(disposeSpy).toHaveBeenCalled();
		expect(b).not.toBe(a);
		reg.disposeAll();
	});

	it("reaps controllers whose node id is no longer live", () => {
		const reg = new EmbedMountRegistry();
		const c = reg.acquire("gone", () => EmbedMountController.create(liveOpts()), REF);
		const disposeSpy = vi.spyOn(c as EmbedMountController, "dispose");
		reg.reap(new Set(["still-here"]));
		expect(disposeSpy).toHaveBeenCalled();
		// A second reap is a no-op (already gone).
		disposeSpy.mockClear();
		reg.reap(new Set(["still-here"]));
		expect(disposeSpy).not.toHaveBeenCalled();
	});

	it("drops a malformed-ref acquire without registering it", () => {
		const reg = new EmbedMountRegistry();
		const c = reg.acquire(
			"bad",
			() => EmbedMountController.create({ ...liveOpts(), entityRef: "nope" }),
			"nope",
		);
		expect(c).toBeNull();
	});
});

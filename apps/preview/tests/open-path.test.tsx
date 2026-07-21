/**
 * @vitest-environment jsdom
 *
 * Open-path wiring test — the chain that was broken: a real `intent.open` /
 * `quick-look` launch payload must end up rendering the file.
 *
 * The shell's *guaranteed* fresh-launch delivery is only the handshake
 * `LaunchContext = { reason: "open-entity", entityId }` (no MIME / URL /
 * siblings — those ride the `app:intent` push, which the bus fires only for
 * an already-running window). Preview resolves that bare id via
 * `entities.get` → `entityToPreviewFile` → gallery state → text-renderer
 * mount → file content in the DOM.
 *
 * Renders the real `<PreviewApp />` under jsdom with a mock `brainstorm`
 * runtime and asserts the full chain executes, plus the already-running
 * (`runtime.on("intent")`) path and the pure `entityToPreviewFile` resolver.
 */

import { type ReactElement, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewApp } from "../src/app";
import { entityToPreviewFile } from "../src/logic/entity-to-file";
import { registerBuiltInPreviewModules } from "../src/logic/registry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE_TEXT = "hello from the opened file\n";

type IntentEvent = {
	type: string;
	intent?: { verb?: string; payload?: Record<string, unknown> };
};

type MockRuntime = {
	launch?: Record<string, unknown>;
	services: { entities: { get: ReturnType<typeof vi.fn> } };
	on: (event: "intent", handler: (e: IntentEvent) => void) => { unsubscribe: () => void };
};

let intentHandler: ((e: IntentEvent) => void) | null = null;

function fileEntity(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		type: "brainstorm/File/v1",
		properties: {
			name: "notes.txt",
			mime: "text/plain",
			size: FILE_TEXT.length,
			attachment: `brainstorm://file/${id}`,
			updatedAt: 1_700_000_000_000,
			...overrides,
		},
	};
}

function installRuntime(
	launch: Record<string, unknown> | undefined,
	getImpl: (id: string) => unknown,
): MockRuntime {
	intentHandler = null;
	const runtime: MockRuntime = {
		...(launch ? { launch } : {}),
		services: { entities: { get: vi.fn(async (id: string) => getImpl(id)) } },
		on: (event, handler) => {
			if (event === "intent") intentHandler = handler;
			return { unsubscribe: () => undefined };
		},
	};
	(window as unknown as { brainstorm: MockRuntime }).brainstorm = runtime;
	return runtime;
}

async function flush(): Promise<void> {
	// resolveOpenPayload → entities.get → entityToPreviewFile → setState →
	// RenderSurface effect → loader() (await import) → mount (await fetch). A
	// handful of macrotasks covers the whole async chain.
	await act(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
	});
}

/** Poll until `predicate` holds — the dynamic `import()` of a renderer
 *  module + the mount `fetch` are an indeterminate number of macrotasks, so a
 *  single fixed sleep is flaky. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		});
	}
}

async function mount(node: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(node);
	});
	return { container, root };
}

describe("entityToPreviewFile (pure resolver)", () => {
	it("maps a File entity to a url-source PreviewFile", () => {
		const file = entityToPreviewFile(fileEntity("ent_1"));
		expect(file).not.toBeNull();
		expect(file?.id).toBe("ent_1");
		expect(file?.info.name).toBe("notes.txt");
		expect(file?.info.mime).toBe("text/plain");
		expect(file?.source).toEqual({
			kind: "url",
			url: "brainstorm://file/ent_1",
			mime: "text/plain",
			sizeBytes: FILE_TEXT.length,
		});
	});

	it("returns null when the row lacks a usable URL or MIME", () => {
		expect(entityToPreviewFile(null)).toBeNull();
		expect(entityToPreviewFile(fileEntity("e", { attachment: undefined }))).toBeNull();
		expect(entityToPreviewFile(fileEntity("e", { mime: undefined }))).toBeNull();
		expect(entityToPreviewFile({ id: "e" })).toBeNull();
		expect(entityToPreviewFile({ properties: { mime: "text/plain", attachment: "x" } })).toBeNull();
	});

	it("falls back to the id as the name when name is missing", () => {
		const file = entityToPreviewFile(fileEntity("ent_x", { name: undefined }));
		expect(file?.info.name).toBe("ent_x");
	});
});

describe("preview open-path: launch handshake → render", () => {
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		registerBuiltInPreviewModules();
		(window as { brainstorm?: unknown }).brainstorm = undefined;
		if (!("ResizeObserver" in window)) {
			(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
				observe() {}
				unobserve() {}
				disconnect() {}
			};
		}
		if (!window.matchMedia) {
			(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
				matches: false,
				addEventListener() {},
				removeEventListener() {},
			});
		}
		globalThis.fetch = vi.fn(async () => new Response(FILE_TEXT, { status: 200 })) as never;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		(window as { brainstorm?: unknown }).brainstorm = undefined;
	});

	it("a fresh open-entity launch resolves the id and renders the file", async () => {
		const rt = installRuntime({ reason: "open-entity", entityId: "ent_42" }, (id) => fileEntity(id));

		const { container } = await mount(<PreviewApp />);
		await waitFor(() =>
			(container.querySelector(".preview__stage")?.textContent ?? "").includes(
				"hello from the opened file",
			),
		);

		expect(rt.services.entities.get).toHaveBeenCalledWith("ent_42");
		expect(container.querySelector(".preview__filename")?.textContent).toBe("notes.txt");
		expect(container.querySelector(".preview__render-surface")).not.toBeNull();
		expect(container.querySelector(".preview__stage")?.textContent).toContain(
			"hello from the opened file",
		);
	});

	it("no launch keeps the honest empty state (no entities.get, no surface)", async () => {
		const rt = installRuntime({ reason: "fresh" }, (id) => fileEntity(id));

		const { container } = await mount(<PreviewApp />);
		await flush();

		expect(rt.services.entities.get).not.toHaveBeenCalled();
		expect(container.querySelector(".preview__render-surface")).toBeNull();
		// Marcus 911 — header falls back to the app name when nothing is open.
		expect(container.querySelector(".preview__filename")?.textContent).toBe("Preview");
	});

	it("an already-running quick-look intent renders via runtime.on('intent')", async () => {
		const rt = installRuntime(undefined, (id) => fileEntity(id, { name: "peek.txt" }));

		const { container } = await mount(<PreviewApp />);
		await flush();
		expect(intentHandler).toBeTypeOf("function");

		await act(async () => {
			intentHandler?.({
				type: "intent",
				intent: { verb: "quick-look", payload: { entityId: "ent_run" } },
			});
		});
		await waitFor(() =>
			(container.querySelector(".preview__stage")?.textContent ?? "").includes(
				"hello from the opened file",
			),
		);

		expect(rt.services.entities.get).toHaveBeenCalledWith("ent_run");
		expect(container.querySelector(".preview__filename")?.textContent).toBe("peek.txt");
		expect(container.querySelector(".preview__stage")?.textContent).toContain(
			"hello from the opened file",
		);
	});

	it("an inlined-siblings open builds the gallery without entities.get", async () => {
		const rt = installRuntime(undefined, (id) => fileEntity(id));

		const { container } = await mount(<PreviewApp />);
		await flush();

		await act(async () => {
			intentHandler?.({
				type: "intent",
				intent: {
					verb: "open",
					payload: {
						entityId: "ent_b",
						context: { kind: "folder", sourceId: "fold_1", label: "Shots" },
						siblings: [
							{ id: "ent_a", name: "a.txt", mime: "text/plain", url: "brainstorm://file/a" },
							{ id: "ent_b", name: "b.txt", mime: "text/plain", url: "brainstorm://file/b" },
						],
					},
				},
			});
		});
		await flush();

		expect(rt.services.entities.get).not.toHaveBeenCalled();
		expect(container.querySelector(".preview__filename")?.textContent).toBe("b.txt");
	});
});

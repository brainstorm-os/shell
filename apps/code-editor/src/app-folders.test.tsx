// @vitest-environment jsdom
/**
 * 9.7.12 — the FILES folder tree, against the React app in shell mode.
 *
 * Covers the write paths a folder adds on top of the flat list: creating
 * inside the focused folder, the "New folder" affordance (a UI-only node
 * until a file lands in it), the bulk folder rename (N × `entities.update`
 * in one user action), drag-to-move a file between folders, and the
 * read-only lock refusing every one of them.
 *
 * A fake `window.brainstorm` runtime installed FIRST puts the app in shell
 * mode against an in-memory entity store whose `onChange` drives the real
 * vault-list store (250ms coalesce — hence the waitFor polling).
 */
import { ENTITY_DRAG_MIME } from "@brainstorm-os/sdk/entity-drag";
import { type ContextMenuItem, openContextMenu } from "@brainstorm-os/sdk/menus";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeEditorApp } from "./app";
import { CODE_FILE_ENTITY_TYPE, type CodeEditorRuntime, type VaultEntity } from "./runtime";

// The fancy-menus runtime has no host in jsdom, so the folder menu is
// asserted at its call site — the item list IS the contract, and running an
// item's `onSelect` is exactly what a click would do.
vi.mock("@brainstorm-os/sdk/menus", async (importOriginal) => ({
	...(await importOriginal<typeof import("@brainstorm-os/sdk/menus")>()),
	mountMenuHost: vi.fn(),
	openContextMenu: vi.fn(() => true),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Open a folder row's context menu and run the item whose label matches. */
function runFolderMenuItem(folderPath: string, label: string): void {
	const row = document.querySelector<HTMLElement>(
		`.editor__folder[data-folder-path="${folderPath}"]`,
	);
	if (!row) throw new Error(`no folder row for ${folderPath}`);
	vi.mocked(openContextMenu).mockClear();
	act(() => {
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	});
	const items = vi.mocked(openContextMenu).mock.calls.at(-1)?.[1] as ContextMenuItem[] | undefined;
	const item = items?.find((i) => i.label.includes(label));
	if (!item) throw new Error(`no "${label}" item in [${items?.map((i) => i.label).join(", ")}]`);
	act(() => item.onSelect?.());
}

function makeFakeRuntime(seed: { path: string; locked?: boolean }[]) {
	const changeListeners = new Set<() => void>();
	const entities: VaultEntity[] = seed.map((file, index) => ({
		id: `code-${index + 1}`,
		type: CODE_FILE_ENTITY_TYPE,
		properties: { path: file.path, content: "", ...(file.locked ? { locked: true } : {}) },
		createdAt: index + 1,
		updatedAt: index + 1,
		deletedAt: null,
		ownerAppId: "io.brainstorm.code-editor",
	}));
	const notify = () => {
		for (const listener of [...changeListeners]) listener();
	};
	const create = vi.fn(async (type: string, properties: Record<string, unknown>) => {
		const id = `code-${entities.length + 1}`;
		entities.push({
			id,
			type,
			properties,
			createdAt: entities.length + 1,
			updatedAt: entities.length + 1,
			deletedAt: null,
			ownerAppId: "io.brainstorm.code-editor",
		});
		notify();
		return { id };
	});
	const update = vi.fn(async (id: string, patch: Record<string, unknown>) => {
		const entity = entities.find((e) => e.id === id);
		if (entity) Object.assign(entity.properties, patch);
		notify();
	});
	const runtime = {
		on(event: string, handler: (arg?: unknown) => void) {
			if (event === "ready") {
				handler();
				return undefined;
			}
			return { unsubscribe() {} };
		},
		services: {
			vaultEntities: {
				list: async () => ({ entities: entities.map((e) => ({ ...e })), links: [] }),
				onChange(listener: () => void) {
					changeListeners.add(listener);
					return { unsubscribe: () => changeListeners.delete(listener) };
				},
			},
			entities: {
				loadDoc: async () => ({ snapshotB64: null }),
				applyDoc: () => undefined,
				closeDoc: () => undefined,
				create,
				update,
				delete: async () => undefined,
			},
		},
	} as unknown as CodeEditorRuntime;
	return { runtime, create, update, entities };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	// The shared popover mounts on `document.body`, outside the React root —
	// drop it so a test never inherits the previous one's dialog.
	for (const popover of document.querySelectorAll(".bs-popover-backdrop, .bs-popover")) {
		popover.remove();
	}
	window.brainstorm = undefined;
	vi.mocked(openContextMenu).mockClear();
});

async function mount(runtime: CodeEditorRuntime): Promise<void> {
	window.brainstorm = runtime;
	act(() => {
		root = createRoot(container);
		root.render(<CodeEditorApp />);
	});
	await vi.waitFor(
		() => {
			expect(document.querySelectorAll(".editor__file[data-file-id]").length).toBeGreaterThan(0);
			// Wait for the tree's roving focus to SETTLE on the auto-selected file
			// too: the app picks a selection one effect after the rows land, and
			// the tree follows it — a test that acts before that lands races the
			// pending `setActiveId` and has its own focus move overwritten.
			expect(document.querySelector('.editor__file[aria-selected="true"]')).not.toBeNull();
		},
		{ timeout: 3000 },
	);
}

const folderRow = (path: string) =>
	document.querySelector<HTMLElement>(`.editor__folder[data-folder-path="${path}"]`);
const filePaths = () =>
	[...document.querySelectorAll<HTMLElement>(".editor__file[data-file-id]")].map(
		(el) => el.querySelector(".editor__file-open")?.getAttribute("title") ?? "",
	);
const renameInput = () => document.querySelector<HTMLInputElement>(".editor__rename-input");

/** Drive the shared rename popover: retype the path and click Save. */
function submitRename(next: string): void {
	const input = renameInput();
	if (!input) throw new Error("rename popover not open");
	act(() => {
		input.value = next;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const save = [...document.querySelectorAll<HTMLButtonElement>(".bs-popover .bs-btn")].find(
		(btn) => btn.dataset.bsPrimary !== undefined,
	);
	act(() => save?.click());
}

describe("folder tree — structure", () => {
	it("derives folder rows from the shared path prefixes", async () => {
		const { runtime } = makeFakeRuntime([
			{ path: "hello-app/manifest.json" },
			{ path: "hello-app/src/main.ts" },
			{ path: "readme.md" },
		]);
		await mount(runtime);

		expect(folderRow("hello-app")).not.toBeNull();
		expect(folderRow("hello-app/src")).not.toBeNull();
		expect(folderRow("hello-app/src")?.getAttribute("aria-level")).toBe("2");
		// A root-level file keeps level 1 — no phantom folder is invented.
		const readme = [...document.querySelectorAll<HTMLElement>(".editor__file[data-file-id]")].find(
			(el) => el.querySelector(".editor__file-open")?.getAttribute("title") === "readme.md",
		);
		expect(readme?.getAttribute("aria-level")).toBe("1");
	});

	it("writes the collapsed set to the app's own localStorage namespace", async () => {
		await mount(makeFakeRuntime([{ path: "lib/one.ts" }, { path: "lib/two.ts" }]).runtime);
		expect(folderRow("lib")?.getAttribute("aria-expanded")).toBe("true");
		act(() => folderRow("lib")?.click());
		expect(folderRow("lib")?.getAttribute("aria-expanded")).toBe("false");
		expect(document.querySelectorAll(".editor__file[data-file-id]")).toHaveLength(0);
		expect(localStorage.getItem("code-editor:collapsed-folders")).toContain("lib");
	});

	it("honours a persisted collapsed folder on first paint", async () => {
		localStorage.setItem("code-editor:collapsed-folders", JSON.stringify(["lib"]));
		const { runtime } = makeFakeRuntime([{ path: "lib/one.ts" }, { path: "root.ts" }]);
		window.brainstorm = runtime;
		act(() => {
			root = createRoot(container);
			root.render(<CodeEditorApp />);
		});
		await vi.waitFor(() => expect(folderRow("lib")).not.toBeNull(), { timeout: 3000 });
		expect(folderRow("lib")?.getAttribute("aria-expanded")).toBe("false");
		expect(filePaths()).toEqual(["root.ts"]);
	});
});

describe("folder tree — create", () => {
	it("creates a new file inside the focused folder", async () => {
		const { runtime, create } = makeFakeRuntime([{ path: "lib/one.ts" }, { path: "root.ts" }]);
		await mount(runtime);

		// Click, not a synthetic FocusEvent: React's `onFocus` rides delegated
		// `focusin`, which jsdom delivers unreliably — the row's click handler
		// sets the active row directly, which is what a real click does anyway.
		act(() => folderRow("lib")?.click());
		const newBtn = document.querySelector<HTMLButtonElement>(".editor__file-new");
		expect(newBtn).not.toBeNull();
		act(() => newBtn?.click());
		await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
		expect(create).toHaveBeenCalledWith(
			CODE_FILE_ENTITY_TYPE,
			expect.objectContaining({ path: "lib/untitled.ts" }),
		);
	});

	it("New folder adds a UI-only row that persists, then retires when a file lands in it", async () => {
		const { runtime, create } = makeFakeRuntime([{ path: "lib/one.ts" }]);
		await mount(runtime);

		// Driven from the folder's own menu so the parent is unambiguous.
		runFolderMenuItem("lib", "New folder");

		// A folder with no files is local view state — no entity is minted.
		expect(create).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(folderRow("lib/new-folder")).not.toBeNull());
		expect(localStorage.getItem("code-editor:pending-folders")).toContain("lib/new-folder");
		// Creation invites a name: the rename popover is armed on the new row.
		await vi.waitFor(() => expect(renameInput()?.value).toBe("lib/new-folder"));
		act(() =>
			renameInput()?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			),
		);

		// The empty folder retires once a file occupies its prefix.
		runFolderMenuItem("lib/new-folder", "New file here");
		await vi.waitFor(() =>
			expect(create).toHaveBeenCalledWith(
				CODE_FILE_ENTITY_TYPE,
				expect.objectContaining({ path: "lib/new-folder/untitled.ts" }),
			),
		);
		await vi.waitFor(() =>
			expect(localStorage.getItem("code-editor:pending-folders")).not.toContain("new-folder"),
		);
	});

	it("asks the CREATE question, not the rename one, when the naming sheet is armed by a create", async () => {
		const { runtime } = makeFakeRuntime([{ path: "lib/one.ts" }]);
		await mount(runtime);

		const folderSheet = () =>
			document.querySelector<HTMLElement>('[data-testid="code-folder-rename"]');
		runFolderMenuItem("lib", "New folder");
		await vi.waitFor(() => expect(folderSheet()).not.toBeNull());
		const panel = folderSheet();
		expect(panel?.querySelector<HTMLInputElement>(".editor__rename-input")?.value).toBe(
			"lib/new-folder",
		);
		expect(panel?.querySelector(".bs-popover__title")?.textContent).toBe("New folder");
		expect(
			Array.from(panel?.querySelectorAll(".bs-popover__footer button") ?? []).map((b) =>
				b.textContent?.trim(),
			),
		).toEqual(["Cancel", "Create"]);
		// A short body sizes to its content instead of the variant's min-height.
		expect(panel?.classList.contains("bs-popover__panel--fit")).toBe(true);
		act(() => panel?.querySelector<HTMLButtonElement>(".bs-popover__close")?.click());

		// The same sheet reached by RENAMING keeps the rename copy.
		runFolderMenuItem("lib", "Rename folder…");
		await vi.waitFor(() => expect(folderSheet()).not.toBeNull());
		const renamePanel = folderSheet();
		expect(renamePanel?.querySelector<HTMLInputElement>(".editor__rename-input")?.value).toBe(
			"lib",
		);
		expect(renamePanel?.querySelector(".bs-popover__title")?.textContent).toBe("Rename lib");
		expect(
			Array.from(renamePanel?.querySelectorAll(".bs-popover__footer button") ?? []).map((b) =>
				b.textContent?.trim(),
			),
		).toEqual(["Cancel", "Rename"]);
	});

	it("dismisses an empty folder from its own menu, with no vault write", async () => {
		const { runtime, create, update } = makeFakeRuntime([{ path: "lib/one.ts" }]);
		await mount(runtime);

		runFolderMenuItem("lib", "New folder");
		await vi.waitFor(() => expect(folderRow("lib/new-folder")).not.toBeNull());
		act(() =>
			renameInput()?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			),
		);

		runFolderMenuItem("lib/new-folder", "Remove folder");
		await vi.waitFor(() => expect(folderRow("lib/new-folder")).toBeNull());
		expect(create).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("a folder holding files offers no Remove — only an empty one can be dismissed", async () => {
		await mount(makeFakeRuntime([{ path: "lib/one.ts" }]).runtime);
		act(() => {
			folderRow("lib")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		const items = vi.mocked(openContextMenu).mock.calls.at(-1)?.[1] as ContextMenuItem[];
		expect(items.map((i) => i.id)).not.toContain("remove");
	});
});

describe("folder tree — rename", () => {
	it("renames a folder as ONE action that rewrites every descendant path", async () => {
		const { runtime, update } = makeFakeRuntime([
			{ path: "lib/one.ts" },
			{ path: "lib/deep/two.ts" },
			{ path: "other/three.ts" },
		]);
		await mount(runtime);

		runFolderMenuItem("lib", "Rename folder");
		await vi.waitFor(() => expect(renameInput()?.value).toBe("lib"));

		submitRename("src");
		await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
		expect(update.mock.calls.map((c) => c[1])).toEqual(
			expect.arrayContaining([{ path: "src/one.ts" }, { path: "src/deep/two.ts" }]),
		);
		await vi.waitFor(() => expect(filePaths()).toContain("src/deep/two.ts"));
		// The untouched sibling is untouched.
		expect(filePaths()).toContain("other/three.ts");
	});

	it("refuses a folder rename that would collide, keeping the popover open", async () => {
		const { runtime, update } = makeFakeRuntime([{ path: "lib/one.ts" }, { path: "src/two.ts" }]);
		await mount(runtime);

		runFolderMenuItem("lib", "Rename folder");
		await vi.waitFor(() => expect(renameInput()).not.toBeNull());

		submitRename("src");
		expect(update).not.toHaveBeenCalled();
		expect(renameInput()).not.toBeNull();
		expect(document.querySelector<HTMLElement>(".editor__rename-error")?.hidden).toBe(false);
	});

	it("refuses a folder rename when a descendant carries the read-only lock", async () => {
		const { runtime, update } = makeFakeRuntime([
			{ path: "lib/one.ts", locked: true },
			{ path: "lib/two.ts" },
		]);
		await mount(runtime);

		runFolderMenuItem("lib", "Rename folder");
		await vi.waitFor(() => expect(renameInput()).not.toBeNull());

		submitRename("src");
		expect(update).not.toHaveBeenCalled();
		const error = document.querySelector<HTMLElement>(".editor__rename-error");
		expect(error?.hidden).toBe(false);
		expect(error?.textContent).toContain("locked");
	});
});

describe("folder tree — move", () => {
	/** A native intra-renderer drag: the row stamps the shared entity payload
	 *  on `dragstart`, the folder row reads it back on `drop`. */
	function dragFileOnto(source: HTMLElement, target: HTMLElement): void {
		const data = new Map<string, string>();
		const dataTransfer = {
			types: [] as string[],
			setData: (type: string, value: string) => {
				data.set(type, value);
				dataTransfer.types = [...data.keys()];
			},
			getData: (type: string) => data.get(type) ?? "",
			dropEffect: "none",
			effectAllowed: "none",
		};
		const fire = (node: HTMLElement, type: string) => {
			const event = new Event(type, { bubbles: true, cancelable: true });
			Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
			act(() => {
				node.dispatchEvent(event);
			});
		};
		fire(source, "dragstart");
		fire(target, "dragover");
		fire(target, "drop");
	}

	/** Drop a ready-made multi-item object payload straight onto a target — the
	 *  cross-app shape, which this app's own rows never produce. */
	function dropPayloadOn(
		target: HTMLElement,
		items: { entityId: string; entityType: string; label: string }[],
	): void {
		const wire = JSON.stringify({ v: 1, sourceApp: "", items });
		const dataTransfer = {
			types: [ENTITY_DRAG_MIME],
			setData: () => undefined,
			getData: (type: string) => (type === ENTITY_DRAG_MIME ? wire : ""),
			dropEffect: "none",
			effectAllowed: "all",
		};
		for (const type of ["dragover", "drop"]) {
			const event = new Event(type, { bubbles: true, cancelable: true });
			Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
			act(() => {
				target.dispatchEvent(event);
			});
		}
	}

	const rowFor = (path: string) =>
		[...document.querySelectorAll<HTMLElement>(".editor__file[data-file-id]")].find(
			(el) => el.querySelector(".editor__file-open")?.getAttribute("title") === path,
		);

	it("drops a file into a folder as a path re-prefix", async () => {
		const { runtime, update } = makeFakeRuntime([{ path: "one.ts" }, { path: "lib/two.ts" }]);
		await mount(runtime);

		const source = rowFor("one.ts");
		const target = folderRow("lib");
		expect(source && target).toBeTruthy();
		if (source && target) dragFileOnto(source, target);

		await vi.waitFor(() => expect(update).toHaveBeenCalledWith("code-1", { path: "lib/one.ts" }));
		await vi.waitFor(() => expect(filePaths()).toContain("lib/one.ts"));
		// Exactly once: the list body is ALSO a drop zone (it is the root
		// folder), so a row drop that bubbled would move the file straight back
		// out again.
		expect(update).toHaveBeenCalledTimes(1);
	});

	it("a multi-item drop never lands two same-named files on one path", async () => {
		const { runtime, update } = makeFakeRuntime([
			{ path: "a/one.ts" },
			{ path: "b/one.ts" },
			{ path: "dest/keep.ts" },
		]);
		await mount(runtime);

		// A cross-app payload can carry several objects at once — the app plans
		// each against the paths the previous moves already left behind.
		const target = folderRow("dest");
		if (!target) throw new Error("no dest folder");
		dropPayloadOn(target, [
			{ entityId: "code-1", entityType: CODE_FILE_ENTITY_TYPE, label: "one.ts" },
			{ entityId: "code-2", entityType: CODE_FILE_ENTITY_TYPE, label: "one.ts" },
		]);

		await vi.waitFor(() => expect(update).toHaveBeenCalledWith("code-1", { path: "dest/one.ts" }));
		// The second one has nowhere free to land, so it stays put.
		expect(update).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(filePaths()).toContain("b/one.ts"));
	});

	it("a locked file is not draggable and never moves", async () => {
		const { runtime, update } = makeFakeRuntime([
			{ path: "one.ts", locked: true },
			{ path: "lib/two.ts" },
		]);
		await mount(runtime);

		const source = rowFor("one.ts");
		expect(source?.getAttribute("draggable")).toBe("false");
		const target = folderRow("lib");
		if (source && target) dragFileOnto(source, target);
		expect(update).not.toHaveBeenCalled();
	});
});

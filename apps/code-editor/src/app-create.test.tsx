// @vitest-environment jsdom
/**
 * F-205 — the New-file affordances, against the React app. A fresh vault
 * (zero `CodeFile/v1` rows) must offer "New file" in BOTH the empty-state
 * body and the header, and creating must route through the ONE existing
 * `entities.create` path with a collision-free `untitled*.ts` name, then
 * auto-open the fresh file with the buffer focused so typing flows.
 *
 * A fake `window.brainstorm` runtime installed FIRST puts the app in shell
 * mode against an in-memory entity store whose `onChange` drives the real
 * vault-list store (250ms coalesce — hence the waitFor polling).
 */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeEditorApp } from "./app";
import { CODE_FILE_ENTITY_TYPE, type CodeEditorRuntime, type VaultEntity } from "./runtime";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeFakeRuntime() {
	const entities: VaultEntity[] = [];
	const changeListeners = new Set<() => void>();
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
		for (const listener of [...changeListeners]) listener();
		return { id };
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
				list: async () => ({ entities: [...entities], links: [] }),
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
			},
		},
	} as unknown as CodeEditorRuntime;
	return { runtime, create };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	localStorage.clear();
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	window.brainstorm = undefined;
});

describe("new-file affordances (F-205)", () => {
	it("offers New file in the empty state + header, creates through entities.create, opens + focuses the buffer, and never collides on names", async () => {
		const { runtime, create } = makeFakeRuntime();
		window.brainstorm = runtime;
		act(() => {
			root = createRoot(container);
			root.render(<CodeEditorApp />);
		});

		// Empty vault → the honest empty state, now WITH a create CTA.
		await vi.waitFor(() => {
			expect(document.querySelector(".editor__empty")).not.toBeNull();
		});
		const emptyBtn = document.querySelector<HTMLButtonElement>(".editor__empty .editor__empty-new");
		expect(emptyBtn).not.toBeNull();
		expect(emptyBtn?.textContent).toBe("New file");

		// Header carries the same action, sitting BEFORE the panel toggles
		// (content action first, ⋯ last per the header convention).
		const headerBtn = document.querySelector<HTMLButtonElement>(
			".app-header__right .editor__header-new",
		);
		expect(headerBtn).not.toBeNull();
		const navToggle = document.querySelector(".app-header__right .bs-panel-toggle");
		expect(
			headerBtn && navToggle
				? headerBtn.compareDocumentPosition(navToggle) & Node.DOCUMENT_POSITION_FOLLOWING
				: 0,
		).toBeTruthy();

		// Create via the empty-state button → the existing create path, with
		// the collision-free default name.
		act(() => emptyBtn?.click());
		await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
		expect(create).toHaveBeenCalledWith(
			CODE_FILE_ENTITY_TYPE,
			expect.objectContaining({ path: "untitled.ts", content: "" }),
		);

		// The vault round-trip re-projects, auto-selects the fresh file, and
		// focuses its buffer so typing flows immediately.
		await vi.waitFor(
			() => {
				const current = document.querySelector('.editor__file[aria-current="true"]');
				expect(current?.textContent).toContain("untitled.ts");
			},
			{ timeout: 3000 },
		);
		const buffer = document.querySelector<HTMLTextAreaElement>(".editor__buffer");
		expect(buffer).not.toBeNull();
		await vi.waitFor(() => expect(document.activeElement).toBe(buffer), { timeout: 3000 });

		// Second create (header button this time) allocates the next free name.
		act(() => headerBtn?.click());
		await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
		expect(create).toHaveBeenLastCalledWith(
			CODE_FILE_ENTITY_TYPE,
			expect.objectContaining({ path: "untitled-2.ts" }),
		);
		await vi.waitFor(
			() => {
				const current = document.querySelector('.editor__file[aria-current="true"]');
				expect(current?.textContent).toContain("untitled-2.ts");
			},
			{ timeout: 3000 },
		);
	});

	it("disables the references toggle until a file is open (no dead button)", async () => {
		const { runtime } = makeFakeRuntime();
		window.brainstorm = runtime;
		act(() => {
			root = createRoot(container);
			root.render(<CodeEditorApp />);
		});

		// Empty vault → no file selected → the right references toggle is a
		// dead button unless disabled (its panel only mounts with a selection).
		const refsToggle = await vi.waitFor(() => {
			const el = document.querySelector<HTMLButtonElement>('[data-testid="refs-toggle"]');
			expect(el).not.toBeNull();
			return el as HTMLButtonElement;
		});
		expect(refsToggle.disabled).toBe(true);
		// aria-pressed must reflect real visibility: the panel only mounts with a
		// selection, so with none open it reads false even though the persisted
		// `refsOpen` pref is true.
		expect(refsToggle.getAttribute("aria-pressed")).toBe("false");
		act(() => refsToggle.click());
		// The references panel cannot be opened while no file is selected.
		expect(document.querySelector(".editor__refs")).toBeNull();
	});
});

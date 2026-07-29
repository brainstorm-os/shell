// @vitest-environment jsdom
/**
 * POLISH-FN-2 — a rename that changes the extension must re-derive AND
 * persist the file's `language`. `createNewFile` mints `untitled.ts` with
 * `language: typescript`; the inline rename used to write `{ path }` alone,
 * so `manifest.json` / `index.html` stayed TypeScript for every reader: the
 * header chip, the tokenizer, and the diagnostics rail (which then flagged a
 * spurious unclosed-brace while JSON was being typed).
 *
 * Drives the REAL surface the `VID-build-apps` capture used — New file, then
 * the inline rename it arms (F-451) — against an in-memory entity store, so
 * the assertion is on what actually reaches `entities.update`. The
 * degradation rules (unknown extension / no extension) are pinned as pure
 * cases in `logic/language-detect.test.ts`; the two exercised here are the
 * ones a user hits through the UI.
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
		const row = entities.find((e) => e.id === id);
		if (row) {
			row.properties = { ...row.properties, ...patch };
			row.updatedAt += 1;
		}
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
	window.brainstorm = undefined;
	for (const node of document.querySelectorAll('[data-testid="code-rename"]')) node.remove();
});

/** Mount over an empty vault and press "New file" — which creates
 *  `untitled.ts` (language `typescript`) and arms the inline rename on it. */
async function mountAndCreate(): Promise<ReturnType<typeof makeFakeRuntime>> {
	const fake = makeFakeRuntime();
	window.brainstorm = fake.runtime;
	act(() => {
		root = createRoot(container);
		root.render(<CodeEditorApp />);
	});
	const newBtn = await vi.waitFor(() => {
		const el = document.querySelector<HTMLButtonElement>(".editor__empty .editor__empty-new");
		expect(el).not.toBeNull();
		return el as HTMLButtonElement;
	});
	act(() => newBtn.click());
	await vi.waitFor(() => expect(fake.create).toHaveBeenCalledTimes(1));
	expect(fake.create).toHaveBeenCalledWith(
		CODE_FILE_ENTITY_TYPE,
		expect.objectContaining({ path: "untitled.ts", language: "typescript" }),
	);
	return fake;
}

/** Type `next` into the armed rename field and save it. */
async function saveRenameAs(next: string): Promise<void> {
	const input = await vi.waitFor(
		() => {
			const el = document.querySelector<HTMLInputElement>(".editor__rename-input");
			expect(el).not.toBeNull();
			return el as HTMLInputElement;
		},
		{ timeout: 3000 },
	);
	input.value = next;
	const save = document.querySelector<HTMLButtonElement>(
		".editor__rename-actions [data-bs-primary]",
	);
	expect(save).not.toBeNull();
	await act(async () => {
		save?.click();
		await Promise.resolve();
	});
}

describe("rename re-derives the language (POLISH-FN-2)", () => {
	it("persists the re-derived language when the extension changes", async () => {
		const { update } = await mountAndCreate();
		await saveRenameAs("manifest.json");
		expect(update).toHaveBeenCalledWith("code-1", { path: "manifest.json", language: "json" });
		// The header chip follows the re-derived language, not the create-time one.
		await vi.waitFor(
			() => {
				expect(document.querySelector(".editor__lang")?.textContent).toBe("JSON");
			},
			{ timeout: 3000 },
		);
	});

	it("re-derives an HTML rename too (the second AppForge file)", async () => {
		const { update } = await mountAndCreate();
		await saveRenameAs("index.html");
		expect(update).toHaveBeenCalledWith("code-1", { path: "index.html", language: "html" });
		await vi.waitFor(
			() => {
				expect(document.querySelector(".editor__lang")?.textContent).toBe("HTML");
			},
			{ timeout: 3000 },
		);
	});

	it("a same-language move writes only the path", async () => {
		const { update } = await mountAndCreate();
		await saveRenameAs("src/runtime.ts");
		expect(update).toHaveBeenCalledWith("code-1", { path: "src/runtime.ts" });
	});

	it("a no-extension rename keeps the valid language (never writes Unknown)", async () => {
		const { update } = await mountAndCreate();
		await saveRenameAs("README");
		expect(update).toHaveBeenCalledWith("code-1", { path: "README" });
		await vi.waitFor(
			() => {
				expect(document.querySelector(".editor__lang")?.textContent).toBe("TypeScript");
			},
			{ timeout: 3000 },
		);
	});
});

import { openContextMenu } from "@brainstorm/sdk/menus";
import { openAnchoredMenu } from "@brainstorm/sdk/object-menu";
// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeEditorApp } from "./app";
import { flush, renderInto } from "./test/render";

vi.mock("@brainstorm/sdk/menus", () => ({
	mountMenuHost: vi.fn(),
	MenuAlign: { Start: "start", End: "end" },
	openContextMenu: vi.fn(() => true),
	sdkMenuIcon: vi.fn(() => ({ icon: () => null })),
	blankMenuIcon: { icon: () => null },
}));
vi.mock("@brainstorm/sdk/object-menu", () => ({ openAnchoredMenu: vi.fn() }));
vi.mock("@brainstorm/sdk/color-picker", () => ({ openColorPicker: vi.fn() }));

afterEach(() => {
	vi.mocked(openAnchoredMenu).mockClear();
	vi.mocked(openContextMenu).mockClear();
	(window as { brainstorm?: unknown }).brainstorm = undefined;
});

type ReadyHandler = () => void;

/** A minimal in-shell stub: fires `ready` so the live lists bind, exposes a
 *  `vaultEntities` whose snapshot the app derives the theme list from. */
function installShell(entities: Array<{ id: string; type: string; name: string }>): {
	fireReady(): void;
	emitChange(): void;
} {
	const readyHandlers: ReadyHandler[] = [];
	const changeListeners = new Set<() => void>();
	const snapshot = {
		entities: entities.map((e) => ({
			id: e.id,
			type: e.type,
			properties: { name: e.name },
			createdAt: 1,
			updatedAt: 1,
			deletedAt: null,
			ownerAppId: "io.brainstorm.theme-editor",
		})),
		links: [],
	};
	(window as { brainstorm?: unknown }).brainstorm = {
		services: {
			entities: {
				get: async () => null,
				query: async () => [],
				create: async () => ({}),
				update: async () => ({}),
				delete: async () => undefined,
			},
			vaultEntities: {
				list: async () => snapshot,
				queryPattern: async () => ({ ok: true, snapshot }),
				onChange: (l: () => void) => {
					changeListeners.add(l);
					return { unsubscribe: () => changeListeners.delete(l) };
				},
			},
		},
		on: (event: string, handler: ReadyHandler) => {
			if (event === "ready") readyHandlers.push(handler);
			return { unsubscribe: () => undefined };
		},
	};
	return {
		fireReady: () => {
			for (const h of readyHandlers) h();
		},
		emitChange: () => {
			for (const l of changeListeners) l();
		},
	};
}

describe("ThemeEditorApp", () => {
	it("renders the app-header with the title + the ⋯ as the LAST element in __right", async () => {
		const { container, unmount } = await renderInto(<ThemeEditorApp />);
		await flush();
		const header = container.querySelector('[data-testid="app-header"]');
		expect(header?.classList.contains("app-header")).toBe(true);
		expect(container.querySelector(".app-header__title")?.textContent).toBe("Themes");
		const right = container.querySelector(".app-header__right");
		const last = right?.lastElementChild;
		expect(last?.classList.contains("bs-object-menu__more")).toBe(true);
		await unmount();
	});

	it("renders the four editor tabs and switches the active pane", async () => {
		const { container, unmount } = await renderInto(<ThemeEditorApp />);
		await flush();
		const tabs = container.querySelectorAll<HTMLButtonElement>(".te-tab");
		expect(tabs).toHaveLength(4);
		// Default pane = token grid.
		expect(container.querySelector(".te-grid")).toBeTruthy();
		await act(async () => {
			tabs[2]?.click(); // Typography
		});
		expect(container.querySelector(".te-typo")).toBeTruthy();
		expect(container.querySelector(".te-grid")).toBeNull();
		await unmount();
	});

	it("opens the theme selector through the shared select menu (no native select)", async () => {
		const { container, unmount } = await renderInto(<ThemeEditorApp />);
		await flush();
		expect(container.querySelector("select")).toBeNull();
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".te-toolbar__select")?.click();
		});
		expect(openContextMenu).toHaveBeenCalled();
		await unmount();
	});

	it("opens the overflow ⋯ menu through fancy-menus", async () => {
		const { container, unmount } = await renderInto(<ThemeEditorApp />);
		await flush();
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".app-header__right .bs-object-menu__more")?.click();
		});
		expect(openAnchoredMenu).toHaveBeenCalled();
		await unmount();
	});

	it("shows the offline status when saving outside the shell", async () => {
		const { container, unmount } = await renderInto(<ThemeEditorApp />);
		await flush();
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".te-toolbar__save")?.click();
		});
		await flush();
		expect(container.querySelector(".te-toolbar__status")?.textContent).toBe(
			"Running outside the shell — changes are in-memory only.",
		);
		await unmount();
	});

	it("derives the saved-theme list from the live vault snapshot (the ONE stack)", async () => {
		const shell = installShell([
			{ id: "t1", type: "brainstorm/Theme/v1", name: "Studio Dark" },
			{ id: "n1", type: "brainstorm/Note/v1", name: "ignore me" },
		]);
		const { container, unmount } = await renderInto(<ThemeEditorApp />);
		await act(async () => {
			shell.fireReady();
		});
		// Let the async vault `list()` resolve + the coalesced store notify.
		await flush();
		await flush();
		await flush();
		// The theme selector opens an anchored menu listing the builtins + the
		// live saved theme — proof the list bound from `useVaultEntities`.
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".te-toolbar__select")?.click();
		});
		const [, items] = vi.mocked(openContextMenu).mock.calls.at(-1) ?? [];
		const labels = (items as Array<{ label: string }>).map((i) => i.label);
		expect(labels).toContain("Studio Dark");
		await unmount();
	});

	it("fills the height: the body lives under the fixed app-header", async () => {
		const { container, unmount } = await renderInto(<ThemeEditorApp />);
		await flush();
		// The editor body (#app-root) is a sibling AFTER the header inside the
		// React fragment, so the layout pins below the 44px header rather than
		// floating over a void.
		const root = container.querySelector("#app-root");
		expect(root).toBeTruthy();
		expect(container.querySelector(".te-layout")).toBeTruthy();
		expect(container.querySelector(".te-preview")).toBeTruthy();
		await unmount();
	});
});

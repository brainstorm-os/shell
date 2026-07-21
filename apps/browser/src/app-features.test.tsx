// @vitest-environment jsdom
/**
 * Chrome glue for the Browser's session restore (BrowsingSession/v1),
 * find-in-page bar, and per-site permission banner. The pure halves live in
 * `logic/persistence.test.ts` / the shell's `web/*.test.ts`; this exercises
 * the React wiring against fake `webView` + `entities` runtimes.
 */

import {
	SitePermissionKind,
	TabLoadState,
	type WebViewClient,
	type WebViewEvent,
	WebViewEventKind,
} from "@brainstorm-os/sdk-types";
import { openTypeaheadMenu } from "@brainstorm-os/sdk/menus";
import { openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserApp } from "./app";
import { type HistoryVisit, historyRecordToProperties } from "./logic/history";
import { PERSIST_DEBOUNCE_MS, sessionRecordToProperties } from "./logic/persistence";
import type { EntityRecord } from "./runtime";
import type { BrowsingSessionRecord } from "./types/browsing-session";

vi.mock("@brainstorm-os/sdk/menus", async (importOriginal) => ({
	...(await importOriginal<typeof import("@brainstorm-os/sdk/menus")>()),
	mountMenuHost: vi.fn(() => () => {}),
	// The omnibox renders its suggestions through the shared typeahead runtime;
	// with no real menu host mounted here, spy on the opener to assert the
	// omnibox's contract (items / activeIndex / onSelect). The runtime's own
	// rendering + keyboard is covered in the SDK menus tests.
	openTypeaheadMenu: vi.fn(() => true),
	closeTypeaheadMenu: vi.fn(),
}));
vi.mock("@brainstorm-os/sdk/object-menu", () => ({ openAnchoredMenu: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

type FakeWebView = WebViewClient & {
	opened: Array<{ tabId: string; url: string }>;
	navigated: Array<{ tabId: string; url: string }>;
	bounds: Array<{ tabId: string }>;
	closed: string[];
	reloaded: string[];
	finds: Array<{ tabId: string; query: string; forward: boolean }>;
	stopFinds: string[];
	permissions: Array<{ tabId: string; origin: string; permission: string; allow: boolean }>;
	emit: (event: WebViewEvent) => void;
};

function fakeWebView(): FakeWebView {
	const listeners = new Set<(event: WebViewEvent) => void>();
	const noop = () => Promise.resolve();
	const view: FakeWebView = {
		opened: [],
		navigated: [],
		bounds: [],
		closed: [],
		reloaded: [],
		finds: [],
		stopFinds: [],
		permissions: [],
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
		open: (tabId, url) => {
			view.opened.push({ tabId, url });
			return Promise.resolve();
		},
		navigate: (tabId, url) => {
			view.navigated.push({ tabId, url });
			return Promise.resolve();
		},
		back: noop,
		forward: noop,
		reload: (tabId) => {
			view.reloaded.push(tabId);
			return Promise.resolve();
		},
		stop: noop,
		close: (tabId) => {
			view.closed.push(tabId);
			return Promise.resolve();
		},
		activate: noop,
		setBounds: (tabId) => {
			view.bounds.push({ tabId });
			return Promise.resolve();
		},
		findInPage: (tabId, query, forward) => {
			view.finds.push({ tabId, query, forward });
			return Promise.resolve();
		},
		stopFind: (tabId) => {
			view.stopFinds.push(tabId);
			return Promise.resolve();
		},
		capture: () => Promise.resolve(null),
		setSitePermission: (tabId, origin, permission, allow) => {
			view.permissions.push({ tabId, origin, permission, allow });
			return Promise.resolve();
		},
		clearBrowsingData: () => Promise.resolve(),
		setSiteTrust: () => Promise.resolve(),
		isSiteTrusted: () => Promise.resolve(false),
		onEvent: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return view;
}

type FakeEntities = {
	create: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
	query: ReturnType<typeof vi.fn>;
};

function fakeEntities(rows: EntityRecord[] = []): FakeEntities {
	return {
		create: vi.fn(async (type: string) => ({ id: `created:${type}`, type })),
		update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
			id,
			type: "brainstorm/BrowsingSession/v1",
			properties: patch,
			createdAt: 0,
			updatedAt: 0,
		})),
		// Type-scoped like the real entities service — the session restore and
		// the history load must each see only their own rows.
		query: vi.fn(async (q: { type?: string | string[] }) =>
			rows.filter(
				(row) => !q.type || (Array.isArray(q.type) ? q.type.includes(row.type) : row.type === q.type),
			),
		),
	};
}

function storedRecord(): BrowsingSessionRecord {
	return {
		windowId: "main",
		tabs: [
			{
				id: "old-1",
				url: "https://a.test/page",
				title: "Tab A",
				faviconUrl: null,
				pinned: false,
				history: ["https://a.test/", "https://a.test/page"],
				historyIndex: 1,
			},
			{
				id: "old-2",
				url: "https://b.test/",
				title: "Tab B",
				faviconUrl: null,
				pinned: false,
				history: ["https://b.test/"],
				historyIndex: 0,
			},
		],
		activeTabId: "old-2",
		recentlyClosed: [],
		retainHistory: false,
		createdAt: 1,
		updatedAt: 2,
	};
}

function sessionRow(): EntityRecord {
	return {
		id: "session-entity",
		type: "brainstorm/BrowsingSession/v1",
		properties: sessionRecordToProperties(storedRecord()),
		createdAt: 1,
		updatedAt: 2,
	};
}

let root: Root;
let container: HTMLDivElement;
let webView: FakeWebView;
let entities: FakeEntities;

function install(rows: EntityRecord[]): void {
	webView = fakeWebView();
	entities = fakeEntities(rows);
	(window as { brainstorm?: unknown }).brainstorm = {
		services: { webView, entities },
	};
}

beforeEach(() => {
	install([]);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	(window as { brainstorm?: unknown }).brainstorm = undefined;
});

async function render(node: ReactNode): Promise<void> {
	await act(async () => {
		root.render(node);
	});
}

function tabTitles(): string[] {
	return [...container.querySelectorAll(".browser__tab-title")].map((el) => el.textContent ?? "");
}

describe("BrowsingSession/v1 restore", () => {
	it("replaces the blank seed with the stored tabs and opens the restored active tab", async () => {
		install([sessionRow()]);
		await render(<BrowserApp />);
		await act(async () => {});

		expect(tabTitles()).toEqual(["Tab A", "Tab B"]);
		// The blank seed view was torn down…
		expect(webView.closed).toContain("tab-1");
		// …and the restored ACTIVE tab re-navigated its history tip.
		const restoredOpen = webView.opened.at(-1);
		expect(restoredOpen?.url).toBe("https://b.test/");
		// Restored ids are freshly minted — never the persisted ones.
		expect(restoredOpen?.tabId).not.toBe("old-2");
	});

	it("restores when seed load events land before the stored read resolves (real-shell ordering)", async () => {
		// Every real launch interleaves this way: the seed tab's about:blank
		// engine events queue React updates BEFORE the entities read resolves,
		// so the restore's setSession updater is DEFERRED (no eager evaluation).
		// The follow-up that closes the seed view and mounts the restored
		// active tab must not depend on the updater having run synchronously —
		// when it did, the restored tab's view was never opened and its later
		// navigate landed in an unsized 0×0 view (blank page, JS running).
		install([sessionRow()]);
		let release: (rows: EntityRecord[]) => void = () => {};
		const gate = new Promise<EntityRecord[]>((resolve) => {
			release = resolve;
		});
		const passthrough = entities.query.getMockImplementation() as (q: {
			type?: string | string[];
		}) => Promise<EntityRecord[]>;
		entities.query.mockImplementation((q: { type?: string | string[] }) =>
			q.type === "brainstorm/BrowsingSession/v1" ? gate : passthrough(q),
		);
		await render(<BrowserApp />);
		await act(async () => {
			webView.emit({
				kind: WebViewEventKind.LoadStateChanged,
				tabId: "tab-1",
				loadState: TabLoadState.Loading,
			});
			release([sessionRow()]);
		});
		await act(async () => {});

		expect(tabTitles()).toEqual(["Tab A", "Tab B"]);
		expect(webView.closed).toContain("tab-1");
		const restoredOpen = webView.opened.at(-1);
		expect(restoredOpen?.url).toBe("https://b.test/");
		// Every open is chased by a bounds push — without it the host mounts
		// the view 0×0 (SetBounds for a not-yet-open tab is dropped).
		expect(webView.bounds.some((b) => b.tabId === restoredOpen?.tabId)).toBe(true);
	});

	it("keeps a fresh session when nothing was stored", async () => {
		await render(<BrowserApp />);
		await act(async () => {});
		expect(tabTitles()).toEqual(["New tab"]);
		expect(webView.closed).toEqual([]);
	});

	it("debounce-saves the session as ONE entity (create then update)", async () => {
		vi.useFakeTimers();
		try {
			await render(<BrowserApp />);
			// Restore query resolves (empty) → persist gate opens.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			await act(async () => {
				window.dispatchEvent(
					new CustomEvent("brainstorm:tab-command", { detail: { kind: "new-tab" } }),
				);
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 50);
			});
			expect(entities.create).toHaveBeenCalledTimes(1);
			const [type, properties] = entities.create.mock.calls[0] as [string, Record<string, unknown>];
			expect(type).toBe("brainstorm/BrowsingSession/v1");
			expect((properties.tabs as unknown[]).length).toBe(2);

			// A later change updates the SAME entity instead of creating another.
			await act(async () => {
				window.dispatchEvent(
					new CustomEvent("brainstorm:tab-command", { detail: { kind: "new-tab" } }),
				);
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 50);
			});
			expect(entities.create).toHaveBeenCalledTimes(1);
			expect(entities.update).toHaveBeenCalled();
			expect(entities.update.mock.calls.at(-1)?.[0]).toBe("created:brainstorm/BrowsingSession/v1");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("find-in-page", () => {
	async function openFindBar(): Promise<HTMLInputElement> {
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
		});
		const input = container.querySelector<HTMLInputElement>(".browser__findbar-input");
		if (!input) throw new Error("find input missing");
		return input;
	}

	it("Cmd/Ctrl+F opens the bar and typing drives the engine search", async () => {
		await render(<BrowserApp />);
		const input = await openFindBar();

		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, "needle");
		await act(async () => {
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(webView.finds.at(-1)).toEqual({ tabId: "tab-1", query: "needle", forward: true });
	});

	it("paints the active tab's match count from FindResult events", async () => {
		await render(<BrowserApp />);
		const input = await openFindBar();
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, "needle");
		await act(async () => {
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			webView.emit({
				kind: WebViewEventKind.FindResult,
				tabId: "tab-1",
				matches: 14,
				activeMatch: 2,
			});
		});
		expect(container.querySelector(".browser__findbar-count")?.textContent).toBe("2 of 14");
	});

	it("Shift+Enter steps backwards; Escape closes the bar and stops the find", async () => {
		await render(<BrowserApp />);
		const input = await openFindBar();
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, "needle");
		await act(async () => {
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});

		await act(async () => {
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
			);
		});
		expect(webView.finds.at(-1)).toEqual({ tabId: "tab-1", query: "needle", forward: false });

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(container.querySelector(".browser__findbar")).toBeNull();
		expect(webView.stopFinds).toContain("tab-1");
	});
});

describe("per-site permission banner", () => {
	const ask = {
		kind: WebViewEventKind.PermissionRequested,
		tabId: "tab-1",
		origin: "https://cam.test",
		permission: SitePermissionKind.Camera,
	} as const;

	it("surfaces the ask for the active tab", async () => {
		await render(<BrowserApp />);
		await act(async () => {
			webView.emit(ask);
		});
		const banner = container.querySelector(".browser__permission");
		expect(banner?.textContent).toContain("https://cam.test");
	});

	it("Allow persists the grant and reloads the tab", async () => {
		await render(<BrowserApp />);
		await act(async () => {
			webView.emit(ask);
		});
		const allow = container.querySelector<HTMLButtonElement>(".browser__permission-allow");
		await act(async () => allow?.click());
		expect(webView.permissions).toEqual([
			{ tabId: "tab-1", origin: "https://cam.test", permission: "camera", allow: true },
		]);
		expect(webView.reloaded).toContain("tab-1");
		expect(container.querySelector(".browser__permission")).toBeNull();
	});

	it("Block persists the refusal without reloading", async () => {
		await render(<BrowserApp />);
		await act(async () => {
			webView.emit(ask);
		});
		const block = container.querySelector<HTMLButtonElement>(".browser__permission-block");
		await act(async () => block?.click());
		expect(webView.permissions).toEqual([
			{ tabId: "tab-1", origin: "https://cam.test", permission: "camera", allow: false },
		]);
		expect(webView.reloaded).toEqual([]);
		expect(container.querySelector(".browser__permission")).toBeNull();
	});
});

describe("F-426 — actionable tracker shield", () => {
	beforeEach(() => {
		vi.mocked(openAnchoredMenu).mockClear();
	});

	async function blockTrackers(): Promise<void> {
		await act(async () => {
			webView.emit({ kind: WebViewEventKind.UrlChanged, tabId: "tab-1", url: "https://x.test/home" });
		});
		await act(async () => {
			webView.emit({
				kind: WebViewEventKind.TrackerBlocked,
				tabId: "tab-1",
				blockedTrackerCount: 3,
			});
		});
	}

	it("expands into an explainer + a one-click trust-and-reload action", async () => {
		await render(<BrowserApp />);
		await blockTrackers();

		const trustCalls: Array<{ origin: string; trusted: boolean }> = [];
		webView.setSiteTrust = (origin, trusted) => {
			trustCalls.push({ origin, trusted });
			return Promise.resolve();
		};

		const shield = container.querySelector<HTMLButtonElement>('[data-testid="browser-shield"]');
		expect(shield).not.toBeNull();
		await act(async () => shield?.click());

		const items = vi.mocked(openAnchoredMenu).mock.calls.at(-1)?.[1] as Array<{
			label?: string;
			section?: boolean;
			onSelect?: () => void;
		}>;
		// The blocked-tracker count is no longer trivia: it heads an explainer
		// that a site may break, followed by the trust escape hatch.
		expect(items.some((i) => i.section && i.label?.includes("may not work"))).toBe(true);
		const action = items.find((i) => i.onSelect);
		expect(action?.label).toBe("Trust this site & reload");

		await act(async () => action?.onSelect?.());
		expect(trustCalls).toEqual([{ origin: "https://x.test", trusted: true }]);
		expect(webView.reloaded).toContain("tab-1");
	});

	it("shows no shield when nothing was blocked", async () => {
		await render(<BrowserApp />);
		expect(container.querySelector('[data-testid="browser-shield"]')).toBeNull();
	});
});

describe("browsing history", () => {
	function historyRow(visits: HistoryVisit[]): EntityRecord {
		return {
			id: "history-entity",
			type: "brainstorm/BrowsingHistory/v1",
			properties: historyRecordToProperties({ visits, createdAt: 1, updatedAt: 2 }),
			createdAt: 1,
			updatedAt: 2,
		};
	}

	const githubVisit: HistoryVisit = {
		url: "https://github.com/",
		title: "GitHub",
		visitCount: 5,
		lastVisitedAt: 9,
	};

	async function typeOmnibox(text: string): Promise<HTMLInputElement> {
		const input = container.querySelector<HTMLInputElement>(".browser__omnibox");
		if (!input) throw new Error("omnibox missing");
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, text);
		await act(async () => {
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		return input;
	}

	it("records committed navigations (title backfilled) and debounce-persists the log", async () => {
		vi.useFakeTimers();
		try {
			await render(<BrowserApp />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			await act(async () => {
				webView.emit({ kind: WebViewEventKind.UrlChanged, tabId: "tab-1", url: "https://a.test/" });
			});
			await act(async () => {
				webView.emit({ kind: WebViewEventKind.TitleChanged, tabId: "tab-1", title: "Page A" });
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 50);
			});
			const historyCreate = entities.create.mock.calls.find(
				(call) => call[0] === "brainstorm/BrowsingHistory/v1",
			) as [string, { visits: HistoryVisit[] }] | undefined;
			expect(historyCreate).toBeDefined();
			const visits = historyCreate?.[1].visits ?? [];
			expect(visits).toHaveLength(1);
			expect(visits[0]).toMatchObject({
				url: "https://a.test/",
				title: "Page A",
				visitCount: 1,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("suggests stored history while typing; selecting a suggestion navigates", async () => {
		install([historyRow([githubVisit])]);
		await render(<BrowserApp />);
		await act(async () => {});
		vi.mocked(openTypeaheadMenu).mockClear();

		await typeOmnibox("git");
		const opened = vi.mocked(openTypeaheadMenu).mock.calls.at(-1)?.[0];
		expect(opened?.items.map((i) => i.label)).toContain("GitHub");
		expect(opened?.items[0]?.id).toBe("https://github.com/");
		expect(opened?.items[0]?.description).toBe("https://github.com/");

		// The runtime commits a row by id (the visit url) → the omnibox navigates.
		await act(async () => opened?.onSelect("https://github.com/"));
		expect(webView.navigated.at(-1)).toEqual({ tabId: "tab-1", url: "https://github.com/" });
	});

	it("ArrowDown highlights (activeIndex) and Enter navigates the highlighted suggestion", async () => {
		install([historyRow([githubVisit])]);
		await render(<BrowserApp />);
		await act(async () => {});

		const input = await typeOmnibox("git");
		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});
		// ArrowDown moves the host-controlled highlight to the first row.
		expect(vi.mocked(openTypeaheadMenu).mock.calls.at(-1)?.[0]?.activeIndex).toBe(0);

		await act(async () => {
			input.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		expect(webView.navigated.at(-1)).toEqual({ tabId: "tab-1", url: "https://github.com/" });
	});

	it("clears the persisted log from the History menu", async () => {
		vi.useFakeTimers();
		try {
			install([historyRow([githubVisit])]);
			await render(<BrowserApp />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			const button = container.querySelector<HTMLButtonElement>('button[aria-label="History"]');
			await act(async () => button?.click());
			const items = vi.mocked(openAnchoredMenu).mock.calls.at(-1)?.[1] ?? [];
			expect(items.some((i) => i.label === "GitHub")).toBe(true);
			const clear = items.find((i) => i.label === "Clear browsing history");
			expect(clear?.destructive).toBe(true);
			await act(async () => clear?.onSelect?.());
			await act(async () => {
				await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 50);
			});
			const lastHistoryWrite = [...entities.update.mock.calls]
				.reverse()
				.find((call) => call[0] === "history-entity");
			expect((lastHistoryWrite?.[1] as { visits: unknown[] }).visits).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("clip-to-vault (F-235)", () => {
	function installWithNetwork(
		readable: (input: { url: string }) => Promise<{ blocks: unknown[] | null }>,
	): ReturnType<typeof vi.fn> {
		webView = fakeWebView();
		entities = fakeEntities([]);
		const readableFn = vi.fn(readable);
		(window as { brainstorm?: unknown }).brainstorm = {
			services: { webView, entities, network: { readable: readableFn } },
		};
		return readableFn;
	}

	async function navigateActiveTabTo(url: string): Promise<void> {
		await act(async () => {
			webView.emit({ kind: WebViewEventKind.UrlChanged, tabId: "tab-1", url });
		});
	}

	function clipButton(): HTMLButtonElement {
		const btn = container.querySelector<HTMLButtonElement>(".browser__clip");
		if (!btn) throw new Error("clip button missing");
		return btn;
	}

	it("captures the readable body and saves a bookmark with content blocks", async () => {
		const blocks = [{ type: "paragraph", text: "Hello" }];
		const readable = installWithNetwork(async () => ({ blocks }));
		await render(<BrowserApp />);
		await act(async () => {});
		await navigateActiveTabTo("https://example.com/article");

		await act(async () => clipButton().click());
		await act(async () => {});

		expect(readable).toHaveBeenCalledWith({ url: "https://example.com/article" });
		const bookmarkCreate = entities.create.mock.calls.find(
			(call) => call[0] === "brainstorm/Bookmark/v1",
		) as [string, Record<string, unknown>] | undefined;
		expect(bookmarkCreate).toBeDefined();
		expect(bookmarkCreate?.[1].contentBlocks).toEqual(blocks);
		expect(bookmarkCreate?.[1].contentProvenance).toBe("machine-extracted");
		expect(typeof bookmarkCreate?.[1].contentFetchedAt).toBe("number");
	});

	it("saves a link-only bookmark (no blank content stamp) when extraction recovers nothing", async () => {
		installWithNetwork(async () => ({ blocks: null }));
		await render(<BrowserApp />);
		await act(async () => {});
		await navigateActiveTabTo("https://example.com/spa");

		await act(async () => clipButton().click());
		await act(async () => {});

		const bookmarkCreate = entities.create.mock.calls.find(
			(call) => call[0] === "brainstorm/Bookmark/v1",
		) as [string, Record<string, unknown>] | undefined;
		expect(bookmarkCreate).toBeDefined();
		expect(bookmarkCreate?.[1]).not.toHaveProperty("contentBlocks");
		expect(bookmarkCreate?.[1]).not.toHaveProperty("contentProvenance");
	});

	it("still saves a link-only bookmark when the readable fetch rejects", async () => {
		installWithNetwork(async () => {
			throw new Error("egress blocked");
		});
		await render(<BrowserApp />);
		await act(async () => {});
		await navigateActiveTabTo("https://example.com/blocked");

		await act(async () => clipButton().click());
		await act(async () => {});

		const bookmarkCreate = entities.create.mock.calls.find(
			(call) => call[0] === "brainstorm/Bookmark/v1",
		) as [string, Record<string, unknown>] | undefined;
		expect(bookmarkCreate).toBeDefined();
		expect(bookmarkCreate?.[1]).not.toHaveProperty("contentBlocks");
	});
});

describe("clear-data confirmation (Browser-10)", () => {
	function statusTexts(): string[] {
		return [...container.querySelectorAll('[role="status"]')].map((el) => el.textContent ?? "");
	}

	it("surfaces a role=status confirmation when browsing data is cleared", async () => {
		vi.useFakeTimers();
		try {
			install([]);
			await render(<BrowserApp />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			expect(statusTexts().some((text) => text.includes("Browsing data cleared"))).toBe(false);

			const menuButton = container.querySelector<HTMLButtonElement>(
				'button[aria-label="Browser menu"]',
			);
			await act(async () => menuButton?.click());

			const items = vi.mocked(openAnchoredMenu).mock.calls.at(-1)?.[1] ?? [];
			const clear = items.find((item) => item.label === "Clear browsing data…");
			expect(clear?.destructive).toBe(true);

			await act(async () => clear?.onSelect?.());
			expect(statusTexts().some((text) => text.includes("Browsing data cleared"))).toBe(true);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(4000);
			});
			expect(statusTexts().some((text) => text.includes("Browsing data cleared"))).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

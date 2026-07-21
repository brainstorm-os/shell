// @vitest-environment jsdom
/**
 * App-level smoke tests for the React chrome: the live library shelf, the
 * empty-state honesty (no more sample book masquerading as the vault), the
 * EPUB-pending notice, and the TOC/properties inspector wiring. The
 * imperative reading surfaces have their own suites (reader.test.ts /
 * pdf-reader.test.ts); these tests stub the vault snapshot service and
 * assert the React shell around them.
 */

import { openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BooksApp } from "./app";

vi.mock("@brainstorm-os/sdk/object-menu", () => ({
	openAnchoredMenu: vi.fn(),
	openObjectMenu: vi.fn(),
	closeObjectMenu: vi.fn(),
	ObjectMenuMoreButton: () => null,
	ObjectMenuTrigger: ({ children }: { children: unknown }) => children,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class StubResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

type StubEntity = { id: string; type: string; properties: Record<string, unknown> };

function installShell(entities: StubEntity[]): void {
	(window as { brainstorm?: unknown }).brainstorm = {
		services: {
			vaultEntities: {
				list: () => Promise.resolve({ entities, links: [] }),
				onChange: () => ({ unsubscribe: () => {} }),
			},
			entities: {
				get: vi.fn(() => Promise.resolve(null)),
				// The shelf reads its Book/v1 rows through a type-scoped query.
				query: vi.fn((q: { type?: string | string[] }) =>
					Promise.resolve(
						entities.filter((e) =>
							q.type === undefined
								? true
								: Array.isArray(q.type)
									? q.type.includes(e.type)
									: e.type === q.type,
						),
					),
				),
				update: vi.fn(() => Promise.resolve(null)),
				delete: vi.fn(() => Promise.resolve(null)),
			},
		},
	};
}

function bookRow(id: string, name: string, format: string, author = ""): StubEntity {
	return {
		id,
		type: "brainstorm/Book/v1",
		properties: {
			name,
			format,
			author,
			fileId: null,
			spineLength: 3,
			reading: { position: null, progress: 0, lastReadAt: null },
			createdAt: 1,
			updatedAt: 1,
		},
	};
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderApp(): Promise<HTMLDivElement> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(<BooksApp />);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return container;
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	container = null;
	root = null;
	(window as { brainstorm?: unknown }).brainstorm = undefined;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("BooksApp shelf", () => {
	it("renders the live Book/v1 list in the library panel — not the sample book", async () => {
		installShell([
			bookRow("b1", "Deep Work", "pdf", "Cal Newport"),
			bookRow("b2", "Refactoring", "epub", "Martin Fowler"),
		]);
		const el = await renderApp();
		const titles = [...el.querySelectorAll(".books__row-title")].map((n) => n.textContent);
		expect(titles).toEqual(expect.arrayContaining(["Deep Work", "Refactoring"]));
		// Nothing auto-opens: the reader area shows the pick-a-book hint.
		expect(el.querySelector(".books__placeholder")?.textContent).toContain(
			"Select a book from the library.",
		);
		expect(el.querySelector(".books__page")).toBeNull();
	});

	it("header ⋯ is live and opens view-level actions when no book is selected (F-249)", async () => {
		installShell([bookRow("b1", "Deep Work", "pdf", "Cal Newport")]);
		const el = await renderApp();
		const more = el.querySelector<HTMLButtonElement>(".bs-object-menu__more");
		expect(more).not.toBeNull();
		// The ⋯ is no longer disabled in the default no-selection library state.
		expect(more?.disabled).toBe(false);
		await act(async () => {
			more?.click();
		});
		expect(vi.mocked(openAnchoredMenu)).toHaveBeenCalled();
	});

	it("shows the honest empty state when the vault has no books — no sample button", async () => {
		installShell([]);
		const el = await renderApp();
		expect(el.querySelector(".books__library-blank-title")?.textContent).toBe("No books yet");
		// The sample affordance was removed from the shelf; nothing auto-opens.
		expect(el.querySelector(".books__library-sample")).toBeNull();
		expect(el.querySelector(".books__page")).toBeNull();
	});

	it("selecting an EPUB book surfaces the not-built-yet notice instead of the sample", async () => {
		installShell([bookRow("b2", "Refactoring", "epub")]);
		const el = await renderApp();
		const row = el.querySelector<HTMLButtonElement>(".books__row");
		await act(async () => {
			row?.click();
		});
		expect(el.querySelector(".books__placeholder")?.textContent).toContain("EPUB reading");
		expect(el.querySelector(".books__page")).toBeNull();
	});

	it("opens the inspector with properties + contents for the selected book", async () => {
		// Standalone (no vault services) opens straight onto the sample book —
		// the reflow reader + its TOC mount synchronously, so the inspector has
		// real Contents to render without the (removed) sample button.
		const el = await renderApp();
		const props = el.querySelector(".bs-props");
		expect(props).not.toBeNull();
		expect(props?.classList.contains("bs-props--open")).toBe(true);
		expect(props?.textContent).toContain("Author");
		expect(props?.textContent).toContain("Contents");
		// TOC click drives the mounted reader to the chapter.
		const links = [...(props?.querySelectorAll<HTMLButtonElement>(".books__toc-link") ?? [])];
		const last = links[links.length - 1];
		await act(async () => {
			last?.click();
		});
		expect(el.querySelector(".books__page")?.textContent).toContain("Anchor");
	});
});

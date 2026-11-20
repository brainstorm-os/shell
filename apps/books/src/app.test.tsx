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
import { buildConverterEpub, buildZip } from "./logic/zip-fixture";

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

function bookRow(
	id: string,
	name: string,
	format: string,
	author = "",
	locked = false,
): StubEntity {
	return {
		id,
		type: "brainstorm/Book/v1",
		properties: {
			name,
			format,
			author,
			...(locked ? { locked: true } : {}),
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

	// The inspector read the stored fraction as a bare number ("45") while the
	// footer showed the live one ("23% read"); both now come from the reader.
	it("shows the reader's live progress in the inspector, as a percentage", async () => {
		const el = await renderApp();
		const footer = /(\d+)%/.exec(el.querySelector(".books__progress")?.textContent ?? "")?.[1];
		expect(footer).toBeDefined();
		expect(Number(footer)).toBeGreaterThan(0);
		expect(el.querySelector(".bs-cell-progress-text")?.textContent).toBe(`${footer}%`);
	});

	it("carries no Pages row for a reflowable book — the footer owns the page count", async () => {
		const el = await renderApp();
		const labels = [...el.querySelectorAll(".bs-props__row-label")].map((n) => n.textContent);
		expect(labels).toContain("Progress");
		expect(labels).not.toContain("Pages");
	});

	// F-487 — the shared `.bs-props` inspector is `position: fixed`, so it
	// takes no layout space. Books centres a full-bleed reading measure under
	// it, so with the panel open every line ran on underneath: paragraphs read
	// as hard-cut mid-word at the panel edge, and the glass blur turned the
	// occluded tail of each line into grey bars that looked like stuck loading
	// skeletons beside "Author — Empty". The stage reserves the panel width
	// off this flag.
	it("flags the layout while the inspector is open so the reading stage reserves its width", async () => {
		const el = await renderApp();
		const layout = el.querySelector(".books__layout");
		expect(layout?.getAttribute("data-inspector-open")).toBe("true");
	});
});

// Lock-5(b) — Books enforced a `readOnly` that only ever meant "this is the
// built-in sample", so a book the user LOCKED was fully editable. The lock is
// the fleet's synced `properties.locked`, and the header carries the shared
// toggle so it can be set here, not only read.
describe("BooksApp — the read-only lock", () => {
	it("shows the shared lock toggle for a selected book, unpressed when unlocked", async () => {
		installShell([bookRow("b1", "Deep Work", "pdf", "Cal Newport")]);
		const el = await renderApp();
		await act(async () => {
			el.querySelector<HTMLButtonElement>(".books__row")?.click();
		});
		const lock = el.querySelector<HTMLButtonElement>(".bs-lock-button");
		expect(lock).not.toBeNull();
		expect(lock?.getAttribute("aria-pressed")).toBe("false");
	});

	it("reads the lock off the entity and marks the inspector read-only", async () => {
		installShell([bookRow("b1", "Deep Work", "pdf", "Cal Newport", true)]);
		const el = await renderApp();
		await act(async () => {
			el.querySelector<HTMLButtonElement>(".books__row")?.click();
		});
		expect(el.querySelector<HTMLButtonElement>(".bs-lock-button")?.getAttribute("aria-pressed")).toBe(
			"true",
		);
		// The properties panel renders read-only: no add-property affordance.
		expect(el.querySelector(".bs-props__add")).toBeNull();
	});

	it("the toggle persists the flipped lock through entities.update", async () => {
		installShell([bookRow("b1", "Deep Work", "pdf", "Cal Newport")]);
		const el = await renderApp();
		await act(async () => {
			el.querySelector<HTMLButtonElement>(".books__row")?.click();
		});
		await act(async () => {
			el.querySelector<HTMLButtonElement>(".bs-lock-button")?.click();
		});
		const update = (
			window as unknown as {
				brainstorm: { services: { entities: { update: ReturnType<typeof vi.fn> } } };
			}
		).brainstorm.services.entities.update;
		expect(update).toHaveBeenCalledWith("b1", { locked: true });
	});

	// The lock toggle is not a side door — it persists through the SAME gated
	// `patchBook` every other write uses (`logic/book-writes.ts`, where the
	// refusals are pinned). Before Lock-5(e) it called `entities.update`
	// directly, which is why deleting the gate left this whole suite green.
	it("unlocking is the ONE write a locked book still takes", async () => {
		installShell([bookRow("b1", "Deep Work", "pdf", "Cal Newport", true)]);
		const el = await renderApp();
		await act(async () => {
			el.querySelector<HTMLButtonElement>(".books__row")?.click();
		});
		const update = (
			window as unknown as {
				brainstorm: { services: { entities: { update: ReturnType<typeof vi.fn> } } };
			}
		).brainstorm.services.entities.update;
		update.mockClear();
		await act(async () => {
			el.querySelector<HTMLButtonElement>(".bs-lock-button")?.click();
		});
		expect(update).toHaveBeenCalledWith("b1", { locked: false });
	});
});

describe("BooksApp — auto-hide library (7.15)", () => {
	afterEach(() => {
		document.documentElement.removeAttribute("data-bs-autohide-sidebars");
	});

	const library = (el: HTMLElement) => el.querySelector("#books-library") as HTMLElement;
	const collapse = async (el: HTMLElement) => {
		const toggle = el.querySelector<HTMLButtonElement>('[aria-controls="books-library"]');
		await act(async () => toggle?.click());
	};

	it("without the preference, collapsing hides the library out of the tab order", async () => {
		installShell([]);
		const el = await renderApp();
		await collapse(el);
		expect(library(el).hasAttribute("inert")).toBe(true);
		expect(library(el).hasAttribute("data-bs-autohide")).toBe(false);
		expect(el.querySelector(".bs-autohide-edge")).toBeNull();
	});

	it("with the preference on, a collapsed library becomes a hidden overlay with an edge hot-zone", async () => {
		document.documentElement.setAttribute("data-bs-autohide-sidebars", "on");
		installShell([]);
		const el = await renderApp();
		expect(library(el).hasAttribute("data-bs-autohide")).toBe(false);
		await collapse(el);
		expect(library(el).getAttribute("data-bs-autohide")).toBe("hidden");
		expect(library(el).hasAttribute("inert")).toBe(true);
		expect(el.querySelector(".bs-autohide-edge")).not.toBeNull();
	});
});

/** A vault holding one book with a real backing file: the shell stub answers
 *  `entities.get` for both rows and `fetch` serves the file's bytes. */
function installBookWithFile(args: {
	book: Record<string, unknown>;
	file: Record<string, unknown>;
	bytes: Uint8Array;
}): { update: ReturnType<typeof vi.fn> } {
	const book: StubEntity = {
		id: "bk1",
		type: "brainstorm/Book/v1",
		properties: {
			author: "",
			fileId: "file1",
			spineLength: 0,
			reading: { position: null, progress: 0, lastReadAt: null },
			createdAt: 1,
			updatedAt: 1,
			...args.book,
		},
	};
	const file: StubEntity = {
		id: "file1",
		type: "brainstorm/File/v1",
		properties: { attachment: "brainstorm://asset/a1", ...args.file },
	};
	installShell([book, file]);
	const services = (
		window as unknown as {
			brainstorm: { services: { entities: Record<string, ReturnType<typeof vi.fn>> } };
		}
	).brainstorm.services;
	services.entities.get = vi.fn((id: string) =>
		Promise.resolve(id === "bk1" ? book : id === "file1" ? file : null),
	);
	const update = vi.fn(() => Promise.resolve(null));
	services.entities.update = update;
	vi.stubGlobal(
		"fetch",
		vi.fn(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				arrayBuffer: () =>
					Promise.resolve(
						args.bytes.buffer.slice(args.bytes.byteOffset, args.bytes.byteOffset + args.bytes.byteLength),
					),
			}),
		),
	);
	return { update };
}

async function openFirstBook(el: HTMLElement): Promise<void> {
	const row = el.querySelector<HTMLButtonElement>(".books__row");
	await act(async () => {
		row?.click();
	});
	// The open is a chain of awaited steps (rows → bytes → parse → mount).
	for (let i = 0; i < 40; i += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
		const notice = el.querySelector(".books__placeholder")?.textContent ?? "";
		if (!notice.includes("Opening book") && !notice.includes("Select a book")) break;
	}
}

const FB2_BOOK = `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><author><first-name>Стивен</first-name><last-name>Кинг</last-name></author><book-title>Библиотечная полиция</book-title></title-info></description><body><section><title><p>Глава первая</p></title><p>Первый абзац книги.</p></section><section><title><p>Глава вторая</p></title><p>Второй абзац.</p></section></body></FictionBook>`;

describe("BooksApp opening a book file", () => {
	const OWNER_FILE = "King_Chetyre-posle-polunochi_3_Bibliotechnaya-policiya.159046.fb2.epub";

	it("opens the owner's already-imported EPUB and heals its stale labels", async () => {
		const { update } = installBookWithFile({
			// Exactly what an older build wrote: a title that kept `.fb2`, and a
			// file row labelled as a generic binary.
			book: { name: OWNER_FILE.replace(/\.epub$/, ""), format: "epub" },
			file: { name: OWNER_FILE, mime: "application/octet-stream" },
			bytes: buildConverterEpub(),
		});
		const el = await renderApp();
		await openFirstBook(el);
		expect(el.querySelector(".books__placeholder")).toBeNull();
		expect(el.querySelector(".books__page")?.textContent).toContain("Первый текст.");
		expect(update).toHaveBeenCalledWith("file1", { mime: "application/epub+zip" });
		expect(update).toHaveBeenCalledWith("bk1", {
			author: "Стивен Кинг",
			name: "Библиотечная полиция",
		});
	});

	it("opens an FB2 book in the reflow reader with its chapters as contents", async () => {
		const { update } = installBookWithFile({
			book: { name: "King", format: "fb2" },
			file: { name: "King.fb2", mime: "application/x-fictionbook+xml" },
			bytes: new TextEncoder().encode(FB2_BOOK),
		});
		const el = await renderApp();
		await openFirstBook(el);
		expect(el.querySelector(".books__placeholder")).toBeNull();
		expect(el.querySelector(".books__page")?.textContent).toContain("Первый абзац книги.");
		const toc = [...el.querySelectorAll(".books__toc-link")].map((n) => n.textContent);
		expect(toc).toEqual(["Глава первая", "Глава вторая"]);
		expect(update).toHaveBeenCalledWith("bk1", {
			author: "Стивен Кинг",
			name: "Библиотечная полиция",
		});
	});

	it("reads an FB2 that was catalogued as an EPUB, and corrects the record", async () => {
		const { update } = installBookWithFile({
			book: { name: "My own title", format: "epub", author: "Me" },
			file: { name: "book.epub", mime: "application/octet-stream" },
			bytes: new TextEncoder().encode(FB2_BOOK),
		});
		const el = await renderApp();
		await openFirstBook(el);
		expect(el.querySelector(".books__page")?.textContent).toContain("Первый абзац книги.");
		expect(update).toHaveBeenCalledWith("bk1", { format: "fb2" });
		expect(update).toHaveBeenCalledWith("file1", { mime: "application/x-fictionbook+xml" });
		// The user's own title and author are not overwritten by the file's.
		expect(update).not.toHaveBeenCalledWith(
			"bk1",
			expect.objectContaining({ name: expect.anything() }),
		);
	});

	it("names the file and says why when the format is not one Books reads", async () => {
		installBookWithFile({
			book: { name: "Archive", format: "epub" },
			file: { name: "photos.zip", mime: "application/zip" },
			bytes: buildZip([{ name: "a.jpg", data: "x" }]),
		});
		const el = await renderApp();
		await openFirstBook(el);
		const notice = el.querySelector(".books__placeholder")?.textContent ?? "";
		expect(notice).toContain("photos.zip");
		expect(notice).toContain("Books opens EPUB, FB2 and PDF");
		expect(el.querySelector(".books__page")).toBeNull();
	});

	it("reports a damaged EPUB at once instead of a blank reader or an endless spinner", async () => {
		installBookWithFile({
			book: { name: "Broken", format: "epub" },
			file: { name: "broken.epub", mime: "application/epub+zip" },
			// An archive that claims to be an EPUB and has no package document.
			bytes: buildZip([{ name: "mimetype", data: "application/epub+zip" }]),
		});
		const el = await renderApp();
		await openFirstBook(el);
		const notice = el.querySelector(".books__placeholder")?.textContent ?? "";
		expect(notice).toContain("broken.epub");
		expect(notice).toContain("damaged or incomplete");
		expect(el.querySelector(".books__page")).toBeNull();
	});

	it("reports a book whose file row is gone", async () => {
		installBookWithFile({
			book: { name: "Orphan", format: "epub", fileId: "missing" },
			file: { name: "x.epub" },
			bytes: new Uint8Array(0),
		});
		const el = await renderApp();
		await openFirstBook(el);
		const notice = el.querySelector(".books__placeholder")?.textContent ?? "";
		expect(notice).toContain("Orphan");
		expect(notice).toContain("missing from this vault");
	});
});

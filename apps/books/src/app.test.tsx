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

describe("BooksApp library progress with two same-titled books", () => {
	const paragraphs = Array.from(
		{ length: 400 },
		(_, i) => `<p>Абзац номер ${i} — достаточно длинный текст, чтобы книга заняла много страниц.</p>`,
	).join("");
	const LONG_FB2 = `<FictionBook><description><title-info><author><first-name>Стивен</first-name><last-name>Кинг</last-name></author><book-title>Библиотечная полиция</book-title></title-info></description><body><section><title><p>Глава</p></title>${paragraphs}</section></body></FictionBook>`;

	/** A live vault: `update` mutates the row and fires the change signal, so
	 *  the shelf re-reads exactly as it does in the shell. */
	function installTwoBooks(): { rows: StubEntity[]; update: ReturnType<typeof vi.fn> } {
		const book = (id: string, fileId: string): StubEntity => ({
			id,
			type: "brainstorm/Book/v1",
			properties: {
				name: "Библиотечная полиция",
				author: "Стивен Кинг",
				format: "fb2",
				fileId,
				spineLength: 0,
				reading: { position: null, progress: 0, lastReadAt: null },
				createdAt: 1,
				updatedAt: 1,
			},
		});
		const file = (id: string): StubEntity => ({
			id,
			type: "brainstorm/File/v1",
			properties: {
				name: `${id}.fb2`,
				mime: "application/x-fictionbook+xml",
				attachment: `brainstorm://asset/${id}`,
			},
		});
		const rows = [book("bkA", "fileA"), book("bkB", "fileB"), file("fileA"), file("fileB")];
		installShell(rows);
		const listeners = new Set<() => void>();
		const brainstorm = (
			window as unknown as {
				brainstorm: {
					services: {
						vaultEntities: Record<string, unknown>;
						entities: Record<string, unknown>;
					};
				};
			}
		).brainstorm;
		brainstorm.services.vaultEntities.onChange = (listener: () => void) => {
			listeners.add(listener);
			return { unsubscribe: () => listeners.delete(listener) };
		};
		brainstorm.services.entities.get = vi.fn((id: string) =>
			Promise.resolve(rows.find((r) => r.id === id) ?? null),
		);
		brainstorm.services.entities.query = vi.fn(() =>
			Promise.resolve(
				rows
					.filter((r) => r.type === "brainstorm/Book/v1")
					.map((r) => ({ ...r, properties: { ...r.properties }, updatedAt: r.properties.updatedAt })),
			),
		);
		const update = vi.fn((id: string, patch: Record<string, unknown>) => {
			const row = rows.find((r) => r.id === id);
			if (row) row.properties = { ...row.properties, ...patch };
			for (const listener of listeners) listener();
			return Promise.resolve(null);
		});
		brainstorm.services.entities.update = update;
		const bytes = new TextEncoder().encode(LONG_FB2);
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)),
				}),
			),
		);
		return { rows, update };
	}

	async function settle(): Promise<void> {
		for (let i = 0; i < 12; i += 1) {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
			});
		}
	}

	async function clickRow(el: HTMLElement, index: number): Promise<void> {
		const row = el.querySelectorAll<HTMLButtonElement>(".books__row")[index];
		await act(async () => {
			row?.click();
		});
		await settle();
	}

	function rowProgress(el: HTMLElement): Record<string, string> {
		const out: Record<string, string> = {};
		for (const row of el.querySelectorAll<HTMLElement>(".books__row")) {
			const key = row.getAttribute("aria-current") === "true" ? "open" : "other";
			out[key] = row.querySelector(".books__row-progress")?.textContent ?? "";
		}
		return out;
	}

	it("importing two books in a row keeps each one's progress its own", async () => {
		const rows: StubEntity[] = [];
		installShell(rows);
		const listeners = new Set<() => void>();
		const fire = (): void => {
			for (const listener of listeners) listener();
		};
		const brainstorm = (
			window as unknown as {
				brainstorm: {
					services: {
						vaultEntities: Record<string, unknown>;
						entities: Record<string, unknown>;
						files?: Record<string, unknown>;
					};
				};
			}
		).brainstorm;
		brainstorm.services.vaultEntities.onChange = (listener: () => void) => {
			listeners.add(listener);
			return { unsubscribe: () => listeners.delete(listener) };
		};
		brainstorm.services.entities.get = vi.fn((id: string) =>
			Promise.resolve(rows.find((r) => r.id === id) ?? null),
		);
		brainstorm.services.entities.query = vi.fn(() =>
			Promise.resolve(
				rows
					.filter((r) => r.type === "brainstorm/Book/v1")
					.map((r) => ({ ...r, properties: { ...r.properties }, updatedAt: r.properties.updatedAt })),
			),
		);
		let minted = 0;
		brainstorm.services.entities.create = vi.fn(
			(type: string, properties: Record<string, unknown>, id?: string) => {
				minted += 1;
				const row = { id: id ?? `file${minted}`, type, properties: { ...properties } };
				rows.push(row);
				// The broadcast lags the reply, as it does in the shell.
				setTimeout(fire, 20);
				return Promise.resolve({ id: row.id });
			},
		);
		const update = vi.fn((id: string, patch: Record<string, unknown>) => {
			const row = rows.find((r) => r.id === id);
			if (row) row.properties = { ...row.properties, ...patch };
			setTimeout(fire, 0);
			return Promise.resolve(null);
		});
		brainstorm.services.entities.update = update;
		const names = ["one.fb2", "two.fb2"];
		let picked = 0;
		brainstorm.services.files = {
			requestOpen: vi.fn(() => {
				const name = names[picked] ?? "x.fb2";
				picked += 1;
				return Promise.resolve([{ handleId: name, displayName: name }]);
			}),
			import: vi.fn(({ handle }: { handle: { displayName: string } }) =>
				Promise.resolve({
					assetId: handle.displayName,
					contentHash: handle.displayName,
					size: 1,
					mime: "application/octet-stream",
					name: handle.displayName,
				}),
			),
		};
		const bytes = new TextEncoder().encode(LONG_FB2);
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)),
				}),
			),
		);

		const el = await renderApp();
		const importNow = async (): Promise<void> => {
			const button = el.querySelector<HTMLButtonElement>('button[aria-label="Import a book"]');
			expect(button).not.toBeNull();
			await act(async () => {
				button?.click();
			});
			await settle();
			await settle();
		};
		await importNow();
		await importNow();
		const bookRows = rows.filter((r) => r.type === "brainstorm/Book/v1");
		expect(bookRows).toHaveLength(2);

		const next = el.querySelectorAll<HTMLButtonElement>(".books__nav-btn")[1];
		for (let i = 0; i < 5; i += 1) {
			await act(async () => {
				next?.click();
			});
		}
		await settle();

		// Every reading write went to the book that is open — the second import.
		const [first, second] = bookRows;
		expect(first?.properties.reading).toEqual({ position: null, progress: 0, lastReadAt: null });
		expect((second?.properties.reading as { progress: number }).progress).toBeGreaterThan(0);
		const readingWrites = update.mock.calls.filter((call) => "reading" in call[1]);
		expect(readingWrites.length).toBeGreaterThan(0);
		expect(new Set(readingWrites.map((call) => call[0]))).toEqual(new Set([second?.id]));
	});

	it("advancing the open book never touches the other book's row or record", async () => {
		const { rows, update } = installTwoBooks();
		const el = await renderApp();
		await clickRow(el, 0);
		const firstOpen = el.querySelector(".books__row--active");
		expect(firstOpen).not.toBeNull();
		// Open the OTHER book and read on.
		const other = [...el.querySelectorAll<HTMLButtonElement>(".books__row")].findIndex(
			(row) => !row.classList.contains("books__row--active"),
		);
		await clickRow(el, other);
		const next = el.querySelectorAll<HTMLButtonElement>(".books__nav-btn")[1];
		for (let i = 0; i < 5; i += 1) {
			await act(async () => {
				next?.click();
			});
		}
		await settle();

		// Let the shelf re-read the vault after the page-turn writes (the live
		// list coalesces change signals for 250 ms).
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 400));
		});

		const written = new Set(update.mock.calls.map((call) => call[0]));
		expect(written.size).toBe(1);
		const [openId] = [...written];
		const closed = rows.find((r) => r.type === "brainstorm/Book/v1" && r.id !== openId);
		expect(closed?.properties.reading).toEqual({ position: null, progress: 0, lastReadAt: null });
		const shown = rowProgress(el);
		expect(shown.open).not.toBe("");
		expect(shown.other).not.toBe(shown.open);
		expect(shown.other).toBe("");
		// The unopened book stays under "Not started"; only the read one moved.
		const groups = [...el.querySelectorAll(".books__library-group")].map((group) => ({
			label: group.querySelector(".books__library-section")?.textContent,
			rows: group.querySelectorAll(".books__row").length,
			open: group.querySelector(".books__row--active") !== null,
		}));
		expect(groups).toEqual([
			{ label: "Today", rows: 1, open: true },
			{ label: "Not started", rows: 1, open: false },
		]);
	});
});

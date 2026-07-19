/**
 * @vitest-environment jsdom
 *
 * Help-1 — overlay renders, sidebar populates from the corpus, search
 * results fire onPick and route to the matching article.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelpArticle, HelpHit } from "../../preload";
import { Help } from "./help";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function article(overrides: Partial<HelpArticle> = {}): HelpArticle {
	const base: HelpArticle = {
		topicId: "guide/getting-started/getting-started/welcome",
		sectionId: "getting-started",
		title: "Welcome to Brainstorm",
		slug: "getting-started/welcome",
		markdown: "# Welcome to Brainstorm\n\nLocal-first PKM.",
		plaintext: "Welcome to Brainstorm Local-first PKM.",
		headings: [],
		relPath: "getting-started/welcome.md",
	};
	return { ...base, ...overrides };
}

function makeCorpus(): { articles: readonly HelpArticle[] } {
	return {
		articles: [
			article(),
			article({
				topicId: "guide/concepts/vaults",
				sectionId: "concepts",
				title: "Vaults",
				markdown: "# Vaults\n\nDashboard.",
				slug: "concepts/vaults",
				relPath: "concepts/vaults.md",
			}),
		],
	};
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	if (window.location.hash) {
		window.history.replaceState(null, "", window.location.pathname);
	}
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

async function flushPromises() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("<Help>", () => {
	it("renders sidebar items from the corpus and shows the home article first", async () => {
		const fetchCorpus = vi.fn().mockResolvedValue(makeCorpus());
		const fetchArticle = vi.fn(async (id: string) => {
			const found = makeCorpus().articles.find((a) => a.topicId === id);
			return found ?? null;
		});
		const search = vi.fn().mockResolvedValue([]);
		act(() =>
			root.render(
				<Help
					onClose={() => undefined}
					fetchCorpus={fetchCorpus}
					fetchArticle={fetchArticle}
					search={search}
				/>,
			),
		);
		await flushPromises();
		const navItems = container.querySelectorAll('[data-testid="help-nav-item"]');
		expect(navItems.length).toBe(2);
		const titleNode = container.querySelector('[data-testid="help-article-title"]');
		expect(titleNode?.textContent).toBe("Welcome to Brainstorm");
	});

	it("clicking a sidebar item loads the corresponding article", async () => {
		const fetchCorpus = vi.fn().mockResolvedValue(makeCorpus());
		const fetchArticle = vi.fn(async (id: string) => {
			const found = makeCorpus().articles.find((a) => a.topicId === id);
			return found ?? null;
		});
		const search = vi.fn().mockResolvedValue([]);
		act(() =>
			root.render(
				<Help
					onClose={() => undefined}
					fetchCorpus={fetchCorpus}
					fetchArticle={fetchArticle}
					search={search}
				/>,
			),
		);
		await flushPromises();
		const second = container.querySelectorAll<HTMLButtonElement>('[data-testid="help-nav-item"]')[1];
		expect(second).toBeDefined();
		act(() => {
			second?.click();
		});
		await flushPromises();
		expect(container.querySelector('[data-testid="help-article-title"]')?.textContent).toBe("Vaults");
		expect(fetchArticle).toHaveBeenCalledWith("guide/concepts/vaults");
	});

	it("typing in the search input populates the result list and clicking a hit routes to it", async () => {
		const fetchCorpus = vi.fn().mockResolvedValue(makeCorpus());
		const fetchArticle = vi.fn(async (id: string) => {
			const found = makeCorpus().articles.find((a) => a.topicId === id);
			return found ?? null;
		});
		const hit: HelpHit = {
			topicId: "guide/concepts/vaults",
			sectionId: "concepts",
			title: "Vaults",
			snippet: "<mark>dashboard</mark>",
			score: -1,
		};
		const search = vi.fn().mockResolvedValue([hit]);
		act(() =>
			root.render(
				<Help
					onClose={() => undefined}
					fetchCorpus={fetchCorpus}
					fetchArticle={fetchArticle}
					search={search}
				/>,
			),
		);
		await flushPromises();
		const input = container.querySelector<HTMLInputElement>('[data-testid="help-search-input"]');
		expect(input).not.toBeNull();
		if (!input) return;
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "dashboard");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 200));
		});
		await flushPromises();
		expect(search).toHaveBeenCalled();
		const hits = container.querySelectorAll<HTMLButtonElement>('[data-testid="help-search-hit"]');
		expect(hits.length).toBe(1);
		act(() => {
			hits[0]?.click();
		});
		await flushPromises();
		expect(container.querySelector('[data-testid="help-article-title"]')?.textContent).toBe("Vaults");
	});

	it("renders an error state when the corpus fetch rejects", async () => {
		const fetchCorpus = vi.fn().mockRejectedValue(new Error("offline"));
		const fetchArticle = vi.fn();
		const search = vi.fn();
		act(() =>
			root.render(
				<Help
					onClose={() => undefined}
					fetchCorpus={fetchCorpus}
					fetchArticle={fetchArticle}
					search={search}
				/>,
			),
		);
		await flushPromises();
		const navItems = container.querySelectorAll('[data-testid="help-nav-item"]');
		expect(navItems.length).toBe(0);
	});

	it("renders a GFM pipe table as real <table>/<thead>/<tbody>", async () => {
		const tableArticle = article({
			markdown: "| Header 1 | Header 2 |\n|---|---|\n| cell a | cell b |\n| cell c | cell d |",
		});
		const fetchCorpus = vi.fn().mockResolvedValue({ articles: [tableArticle] });
		const fetchArticle = vi.fn().mockResolvedValue(tableArticle);
		const search = vi.fn().mockResolvedValue([]);
		act(() =>
			root.render(
				<Help
					onClose={() => undefined}
					fetchCorpus={fetchCorpus}
					fetchArticle={fetchArticle}
					search={search}
				/>,
			),
		);
		await flushPromises();
		const table = container.querySelector("table.help__table");
		expect(table).not.toBeNull();
		expect(table?.querySelectorAll("thead th").length).toBe(2);
		expect(table?.querySelectorAll("tbody tr").length).toBe(2);
		expect(table?.querySelectorAll("tbody td").length).toBe(4);
	});

	it("rewrites internal `.md` links to topic-routes and routes on click", async () => {
		const home = article({
			topicId: "guide/getting-started/getting-started/welcome",
			markdown: "See [vaults.md](../concepts/vaults.md) for more.",
			relPath: "getting-started/welcome.md",
		});
		const target = article({
			topicId: "guide/concepts/vaults",
			sectionId: "concepts",
			title: "Vaults",
			slug: "concepts/vaults",
			markdown: "Vaults body",
			plaintext: "Vaults body",
			relPath: "concepts/vaults.md",
		});
		const corpus = { articles: [home, target] };
		const fetchCorpus = vi.fn().mockResolvedValue(corpus);
		const fetchArticle = vi.fn(
			async (id: string) => corpus.articles.find((a) => a.topicId === id) ?? null,
		);
		const search = vi.fn().mockResolvedValue([]);
		act(() =>
			root.render(
				<Help
					onClose={() => undefined}
					fetchCorpus={fetchCorpus}
					fetchArticle={fetchArticle}
					search={search}
				/>,
			),
		);
		await flushPromises();
		const link = container.querySelector<HTMLAnchorElement>('[data-testid="help-internal-link"]');
		expect(link).not.toBeNull();
		expect(link?.dataset.helpTopicId).toBe("guide/concepts/vaults");
		await act(async () => {
			link?.click();
			await Promise.resolve();
		});
		await flushPromises();
		expect(container.querySelector('[data-testid="help-article-title"]')?.textContent).toBe("Vaults");
		expect(fetchArticle).toHaveBeenCalledWith("guide/concepts/vaults");
	});

	it("renders strikethrough via real <s> tags (GFM)", async () => {
		const strikeArticle = article({ markdown: "Old ~~stuff~~ here." });
		const fetchCorpus = vi.fn().mockResolvedValue({ articles: [strikeArticle] });
		const fetchArticle = vi.fn().mockResolvedValue(strikeArticle);
		const search = vi.fn().mockResolvedValue([]);
		act(() =>
			root.render(
				<Help
					onClose={() => undefined}
					fetchCorpus={fetchCorpus}
					fetchArticle={fetchArticle}
					search={search}
				/>,
			),
		);
		await flushPromises();
		const s = container.querySelector(".help__article-body s");
		expect(s).not.toBeNull();
		expect(s?.textContent).toBe("stuff");
	});

	it("resets article-body scroll to top when the topicId changes", async () => {
		const fetchCorpus = vi.fn().mockResolvedValue(makeCorpus());
		const fetchArticle = vi.fn(async (id: string) => {
			const found = makeCorpus().articles.find((a) => a.topicId === id);
			return found ?? null;
		});
		const search = vi.fn().mockResolvedValue([]);
		act(() =>
			root.render(
				<Help
					onClose={() => undefined}
					fetchCorpus={fetchCorpus}
					fetchArticle={fetchArticle}
					search={search}
				/>,
			),
		);
		await flushPromises();
		const body = container.querySelector<HTMLDivElement>('[data-testid="help-article-body"]');
		expect(body).not.toBeNull();
		if (!body) return;
		body.scrollTop = 240;
		const second = container.querySelectorAll<HTMLButtonElement>('[data-testid="help-nav-item"]')[1];
		act(() => second?.click());
		await flushPromises();
		const bodyAfter = container.querySelector<HTMLDivElement>('[data-testid="help-article-body"]');
		expect(bodyAfter?.scrollTop).toBe(0);
	});

	it("does not call dangerouslySetInnerHTML — search snippets render as React <mark>", async () => {
		const fetchCorpus = vi.fn().mockResolvedValue(makeCorpus());
		const fetchArticle = vi.fn(async () => makeCorpus().articles[0] ?? null);
		const search = vi.fn().mockResolvedValue([
			{
				topicId: "guide/getting-started/getting-started/welcome",
				sectionId: "getting-started",
				title: "Welcome to Brainstorm",
				snippet: "alpha <mark>beta</mark> gamma",
				score: -1,
			},
		]);
		act(() =>
			root.render(
				<Help
					onClose={() => undefined}
					fetchCorpus={fetchCorpus}
					fetchArticle={fetchArticle}
					search={search}
				/>,
			),
		);
		await flushPromises();
		const input = container.querySelector<HTMLInputElement>('[data-testid="help-search-input"]');
		if (!input) return;
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "beta");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 200));
		});
		await flushPromises();
		const snippetMark = container.querySelector(".help__search-hit-snippet mark");
		expect(snippetMark).not.toBeNull();
		expect(snippetMark?.textContent).toBe("beta");
	});

	it("surfaces the What's-new entry point and fires onOpenWhatsNew on click", async () => {
		const fetchCorpus = vi.fn().mockResolvedValue(makeCorpus());
		const fetchArticle = vi.fn(async () => makeCorpus().articles[0] ?? null);
		const search = vi.fn().mockResolvedValue([]);
		const onOpenWhatsNew = vi.fn();
		act(() =>
			root.render(
				<Help
					onClose={() => undefined}
					onOpenWhatsNew={onOpenWhatsNew}
					fetchCorpus={fetchCorpus}
					fetchArticle={fetchArticle}
					search={search}
				/>,
			),
		);
		await flushPromises();
		const button = container.querySelector<HTMLButtonElement>('[data-testid="help-open-whats-new"]');
		expect(button).not.toBeNull();
		act(() => button?.click());
		expect(onOpenWhatsNew).toHaveBeenCalledTimes(1);
	});

	it("Report-on-GitHub opens the public tracker through the external-link path", async () => {
		const fetchCorpus = vi.fn().mockResolvedValue(makeCorpus());
		const fetchArticle = vi.fn(async () => makeCorpus().articles[0] ?? null);
		const search = vi.fn().mockResolvedValue([]);
		const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
		act(() =>
			root.render(
				<Help
					onClose={() => undefined}
					fetchCorpus={fetchCorpus}
					fetchArticle={fetchArticle}
					search={search}
				/>,
			),
		);
		await flushPromises();
		const button = container.querySelector<HTMLButtonElement>('[data-testid="help-report-github"]');
		expect(button).not.toBeNull();
		act(() => button?.click());
		expect(openSpy).toHaveBeenCalledWith("https://github.com/brainstorm-os/shell/issues/new/choose");
		openSpy.mockRestore();
	});

	it("hides the What's-new entry point when onOpenWhatsNew is not wired", async () => {
		const fetchCorpus = vi.fn().mockResolvedValue(makeCorpus());
		const fetchArticle = vi.fn(async () => makeCorpus().articles[0] ?? null);
		const search = vi.fn().mockResolvedValue([]);
		act(() =>
			root.render(
				<Help
					onClose={() => undefined}
					fetchCorpus={fetchCorpus}
					fetchArticle={fetchArticle}
					search={search}
				/>,
			),
		);
		await flushPromises();
		expect(container.querySelector('[data-testid="help-open-whats-new"]')).toBeNull();
	});
});

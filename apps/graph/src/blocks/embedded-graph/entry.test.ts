// @vitest-environment jsdom
import type { BlockRuntimeContext } from "@brainstorm-os/sdk/block-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootEmbeddedGraph } from "./entry";

const GRAPH_TYPE = "brainstorm/Graph/v1";

function makeCtx(graph: unknown): {
	root: HTMLElement;
	navigate: ReturnType<typeof vi.fn>;
	reportHeight: ReturnType<typeof vi.fn>;
	run(): Promise<void>;
} {
	const root = document.createElement("div");
	document.body.appendChild(root);
	const navigate = vi.fn();
	const reportHeight = vi.fn();
	let loader: (() => void | Promise<void>) | null = null;
	const ctx = {
		entityId: "gr-1",
		capabilities: () => [],
		root,
		graph: (async (messageName: string) =>
			messageName === "getEntity" ? graph : null) as unknown as <T>(
			m: string,
			d: unknown,
		) => Promise<T>,
		navigate,
		reportHeight,
		onLoad: (run: () => void | Promise<void>) => {
			loader = run;
		},
	} satisfies BlockRuntimeContext;
	bootEmbeddedGraph(ctx);
	return { root, navigate, reportHeight, run: async () => loader?.() };
}

function graph(props: Record<string, unknown>): unknown {
	return { entityId: "gr-1", entityTypeId: GRAPH_TYPE, properties: props, updatedAt: 1 };
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("embedded-graph block", () => {
	it("renders the graph name and a subjects/connections summary", async () => {
		const h = makeCtx(
			graph({
				name: "People & Cities",
				pattern: { subjects: { a: {}, b: {}, c: {} }, edges: [{}, {}], primarySubject: "a" },
				views: [],
			}),
		);
		await h.run();
		expect(h.root.querySelector(".bsgr__title")?.textContent).toBe("People & Cities");
		expect(h.root.querySelector(".bsgr__meta")?.textContent).toBe("3 subjects · 2 connections");
	});

	it("appends a view count when there are saved views and pluralises", async () => {
		const h = makeCtx(
			graph({
				name: "Org",
				pattern: { subjects: { a: {} }, edges: [{}], primarySubject: "a" },
				views: ["v1", "v2"],
			}),
		);
		await h.run();
		expect(h.root.querySelector(".bsgr__meta")?.textContent).toBe(
			"1 subject · 1 connection · 2 views",
		);
	});

	it("singularises one subject, one connection, one view", async () => {
		const h = makeCtx(
			graph({
				name: "Solo",
				pattern: { subjects: { a: {} }, edges: [{}], primarySubject: "a" },
				views: ["only"],
			}),
		);
		await h.run();
		expect(h.root.querySelector(".bsgr__meta")?.textContent).toBe(
			"1 subject · 1 connection · 1 view",
		);
	});

	it("handles a missing / malformed pattern", async () => {
		const empty = makeCtx(graph({ name: "Empty" }));
		await empty.run();
		expect(empty.root.querySelector(".bsgr__meta")?.textContent).toBe("0 subjects · 0 connections");

		const malformed = makeCtx(graph({ name: "Bad", pattern: "not-an-object", views: "nope" }));
		await malformed.run();
		expect(malformed.root.querySelector(".bsgr__meta")?.textContent).toBe(
			"0 subjects · 0 connections",
		);
	});

	it("falls back to 'Untitled graph' when the name is missing", async () => {
		const h = makeCtx(graph({ pattern: { subjects: {}, edges: [], primarySubject: "" } }));
		await h.run();
		expect(h.root.querySelector(".bsgr__title")?.textContent).toBe("Untitled graph");
	});

	it("clicking the card navigates to the graph", async () => {
		const h = makeCtx(graph({ name: "People", pattern: { subjects: {}, edges: [] } }));
		await h.run();
		h.root.click();
		expect(h.navigate).toHaveBeenCalledWith("gr-1", GRAPH_TYPE);
	});

	it("reports its content height after rendering", async () => {
		const h = makeCtx(graph({ name: "People", pattern: { subjects: {}, edges: [] } }));
		await h.run();
		expect(h.reportHeight).toHaveBeenCalled();
	});

	it("shows an error card when the graph can't be loaded", async () => {
		const h = makeCtx(null);
		await h.run();
		expect(h.root.querySelector(".bsgr__error")).not.toBeNull();
		expect(h.navigate).not.toHaveBeenCalled();
		expect(h.reportHeight).toHaveBeenCalled();
	});
});

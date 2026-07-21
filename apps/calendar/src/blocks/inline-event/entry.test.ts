// @vitest-environment jsdom
import type { BlockRuntimeContext } from "@brainstorm-os/sdk/block-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootInlineEvent } from "./entry";

const EVENT_TYPE = "brainstorm/Event/v1";

function makeCtx(event: unknown): {
	root: HTMLElement;
	navigate: ReturnType<typeof vi.fn>;
	run(): Promise<void>;
} {
	const root = document.createElement("div");
	document.body.appendChild(root);
	const navigate = vi.fn();
	let loader: (() => void | Promise<void>) | null = null;
	const ctx = {
		entityId: "evt-1",
		capabilities: () => [],
		root,
		graph: (async (messageName: string) =>
			messageName === "getEntity" ? event : null) as unknown as <T>(
			m: string,
			d: unknown,
		) => Promise<T>,
		navigate,
		reportHeight: vi.fn(),
		onLoad: (run: () => void | Promise<void>) => {
			loader = run;
		},
	} satisfies BlockRuntimeContext;
	bootInlineEvent(ctx);
	return { root, navigate, run: async () => loader?.() };
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("inline-event block", () => {
	it("renders title, time, and location", async () => {
		const h = makeCtx({
			entityId: "evt-1",
			entityTypeId: EVENT_TYPE,
			properties: {
				title: "Standup",
				start: Date.UTC(2026, 5, 9, 16, 0),
				end: Date.UTC(2026, 5, 9, 16, 30),
				allDay: false,
				location: "Zoom",
			},
			updatedAt: 1,
		});
		await h.run();
		expect(h.root.querySelector(".bsevt__title")?.textContent).toBe("Standup");
		const metas = [...h.root.querySelectorAll(".bsevt__meta")].map((n) => n.textContent);
		expect(metas).toContain("Zoom");
		// One meta carries the formatted time range.
		expect(metas.some((m) => m && m.length > 0 && m !== "Zoom")).toBe(true);
	});

	it("renders an all-day event without a time range", async () => {
		const h = makeCtx({
			entityId: "evt-1",
			entityTypeId: EVENT_TYPE,
			properties: { title: "Launch day", start: Date.UTC(2026, 5, 9), allDay: true },
			updatedAt: 1,
		});
		await h.run();
		const metas = [...h.root.querySelectorAll(".bsevt__meta")].map((n) => n.textContent ?? "");
		expect(metas.some((m) => m.includes("·"))).toBe(false);
		expect(h.root.querySelector(".bsevt__title")?.textContent).toBe("Launch day");
	});

	it("clicking the card navigates to the event", async () => {
		const h = makeCtx({
			entityId: "evt-1",
			entityTypeId: EVENT_TYPE,
			properties: { title: "Standup", start: Date.UTC(2026, 5, 9, 16, 0), allDay: false },
			updatedAt: 1,
		});
		await h.run();
		h.root.click();
		expect(h.navigate).toHaveBeenCalledWith("evt-1", EVENT_TYPE);
	});

	it("falls back to 'Untitled event' and shows an error on load failure", async () => {
		const root = document.createElement("div");
		document.body.appendChild(root);
		const held: { loader: (() => void | Promise<void>) | null } = { loader: null };
		const ctx = {
			entityId: "evt-1",
			capabilities: () => [],
			root,
			graph: (async () => null) as unknown as <T>(m: string, d: unknown) => Promise<T>,
			navigate: vi.fn(),
			reportHeight: vi.fn(),
			onLoad: (run: () => void | Promise<void>) => {
				held.loader = run;
			},
		} satisfies BlockRuntimeContext;
		bootInlineEvent(ctx);
		await held.loader?.();
		expect(root.querySelector(".bsevt__error")).not.toBeNull();
	});
});

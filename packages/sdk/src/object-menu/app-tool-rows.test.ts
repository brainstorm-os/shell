/**
 * Tool-7 — the object menu's app-tool rows.
 *
 * The rung's invariant is "no dead menu rows". `tools.list` enforces half of it
 * server-side (the caller must hold `tools.call`); these cases pin the half the
 * MENU owns, which the rung's first cut got wrong: a click carries no arguments
 * and no human approval, so a tool needing either would have rendered as an
 * enabled row that refuses every time.
 */

import {
	AppToolEffect,
	type AppToolInput,
	type AppToolRecord,
	AppToolSurface,
	ValueType,
	appToolId,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import type { AnchoredMenuItem } from "./anchored-menu";
import { openObjectMenu } from "./open-object-menu";

const requiredInput: AppToolInput = {
	name: "text",
	description: "the text",
	required: true,
	valueType: ValueType.Text,
};

function tool(name: string, over: Partial<AppToolRecord> = {}): AppToolRecord {
	return {
		id: appToolId("io.example.p", name),
		appId: "io.example.p",
		name,
		title: over.title ?? name,
		description: "does a thing",
		effect: over.effect ?? AppToolEffect.Pure,
		appliesTo: [],
		surfaces: [AppToolSurface.Menu],
		input: over.input ?? [],
		registeredAt: 1,
		appLabel: "Provider",
		...over,
	};
}

/** The menu runtime is structural, so a plain object stands in for the app's.
 *  `openAnchoredMenu` is mocked at the module boundary — a `spyOn` cannot
 *  replace an ESM binding the module under test already imported. */
const opened: { items: AnchoredMenuItem[] } = { items: [] };
vi.mock("./anchored-menu", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./anchored-menu")>();
	return {
		...actual,
		openAnchoredMenu: (_point: unknown, items: AnchoredMenuItem[]) => {
			opened.items = items;
		},
	};
});

async function rowsFor(
	tools: readonly AppToolRecord[],
	extra: { onToolConfirm?: () => Promise<boolean> } = {},
): Promise<{
	labels: string[];
	call: ReturnType<typeof vi.fn>;
	outcomes: unknown[];
	click: (needle: string) => void;
}> {
	opened.items = [];
	const call = vi.fn(async () => ({ value: "ok" }));
	const outcomes: unknown[] = [];
	const runtime = {
		services: {
			appTools: { list: async () => tools, call },
			intents: {},
		},
	};
	await openObjectMenu(
		{ x: 0, y: 0 },
		{
			target: { entityId: "e1", entityType: "brainstorm/Note/v1" },
			runtime: runtime as never,
			omitOpen: true,
			// Rows only render for a host that can report an outcome, so every
			// case here supplies the seam.
			onToolResult: (o: unknown) => outcomes.push(o),
			...extra,
		},
	);
	const labels: string[] = [];
	const flat: AnchoredMenuItem[] = [];
	const walk = (items: readonly AnchoredMenuItem[]) => {
		for (const item of items) {
			flat.push(item);
			if (item.label) labels.push(item.label);
			if (item.submenu) walk(item.submenu);
		}
	};
	walk(opened.items);
	const click = (needle: string) => {
		const row = flat.find((i) => i.label?.includes(needle));
		if (!row?.onSelect) throw new Error(`no row matching ${needle}`);
		row.onSelect();
	};
	return { labels, call, outcomes, click };
}

describe("object menu — app tool rows", () => {
	it("offers a zero-argument auto-run tool, with the provider attributed", async () => {
		const { labels } = await rowsFor([tool("slugify", { title: "Slugify" })]);
		// Attribution must be IN THE LABEL: the menu runtime drops `hint`, and
		// two apps' same-titled tools are deliberately kept as two rows.
		expect(labels.some((l) => l.includes("Slugify") && l.includes("Provider"))).toBe(true);
	});

	it("does NOT offer a tool with a required argument", async () => {
		// A menu click supplies no args, so `tools.call` would refuse `Invalid`
		// every time. An argument prompt is Tool-8's proposal tray.
		const { labels } = await rowsFor([tool("rewrite", { title: "Rewrite", input: [requiredInput] })]);
		expect(labels.some((l) => l.includes("Rewrite"))).toBe(false);
	});

	it("does NOT offer a confirm-requiring tool when the host cannot ask", async () => {
		const { labels } = await rowsFor([
			tool("publish", { title: "Publish", effect: AppToolEffect.External }),
		]);
		expect(labels.some((l) => l.includes("Publish"))).toBe(false);
	});

	it("runs a confirm-requiring tool only after a human YES, and passes confirmed", async () => {
		const external = tool("publish", { title: "Publish", effect: AppToolEffect.External });
		const yes = await rowsFor([external], { onToolConfirm: async () => true });
		expect(yes.labels.some((l) => l.includes("Publish"))).toBe(true);
		yes.click("Publish");
		await vi.waitFor(() => expect(yes.call).toHaveBeenCalledTimes(1));
		// `confirmed` is only ever set because a human answered — never invented.
		expect(yes.call.mock.calls[0]?.[0]).toMatchObject({ confirmed: true });
	});

	it("does NOT call when the human answers no", async () => {
		const external = tool("publish", { title: "Publish", effect: AppToolEffect.External });
		const no = await rowsFor([external], { onToolConfirm: async () => false });
		no.click("Publish");
		await new Promise((r) => setTimeout(r, 10));
		expect(no.call).not.toHaveBeenCalled();
		expect(no.outcomes).toEqual([]);
	});

	it("reports a refusal instead of swallowing it", async () => {
		const { click, call, outcomes } = await rowsFor([tool("slugify", { title: "Slugify" })]);
		call.mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "Denied" }));
		click("Slugify");
		await vi.waitFor(() => expect(outcomes).toHaveLength(1));
		expect(outcomes[0]).toMatchObject({ ok: false, kind: "Denied" });
	});

	it("renders no tool rows at all when the host cannot report outcomes", async () => {
		// Without the seam every refusal would vanish into an unhandled
		// rejection — "never silent" broken in the quietest possible way.
		opened.items = [];
		await openObjectMenu(
			{ x: 0, y: 0 },
			{
				target: { entityId: "e1", entityType: "brainstorm/Note/v1" },
				runtime: {
					services: {
						appTools: {
							list: async () => [tool("slugify", { title: "Slugify" })],
							call: vi.fn(),
						},
						intents: {},
					},
				} as never,
				omitOpen: true,
			},
		);
		expect(opened.items.some((i) => i.label?.includes("Slugify"))).toBe(false);
	});
});

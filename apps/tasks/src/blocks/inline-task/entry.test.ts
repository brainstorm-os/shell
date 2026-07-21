// @vitest-environment jsdom
import type { BlockRuntimeContext } from "@brainstorm-os/sdk/block-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootInlineTask } from "./entry";

const TASK_TYPE = "brainstorm/Task/v1";

interface CtxHarness {
	ctx: BlockRuntimeContext;
	root: HTMLElement;
	graph: ReturnType<typeof vi.fn>;
	navigate: ReturnType<typeof vi.fn>;
	run(): Promise<void>;
}

function makeCtx(task: unknown): CtxHarness {
	const root = document.createElement("div");
	document.body.appendChild(root);
	const graph = vi.fn(async (messageName: string) => {
		if (messageName === "getEntity") return task;
		return { ok: true };
	});
	const navigate = vi.fn();
	let loader: (() => void | Promise<void>) | null = null;
	const ctx = {
		entityId: "task-1",
		capabilities: () => [],
		root,
		graph: graph as unknown as <T>(m: string, d: unknown) => Promise<T>,
		navigate,
		reportHeight: vi.fn(),
		onLoad: (run: () => void | Promise<void>) => {
			loader = run;
		},
	} satisfies BlockRuntimeContext;
	bootInlineTask(ctx);
	return {
		ctx,
		root,
		graph,
		navigate,
		run: async () => {
			await loader?.();
		},
	};
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("inline-task block", () => {
	it("renders an unchecked task with its title and due chip", async () => {
		const h = makeCtx({
			entityId: "task-1",
			entityTypeId: TASK_TYPE,
			properties: { name: "Ship v1 spec", dueAt: Date.UTC(2026, 5, 9) },
			updatedAt: 1,
		});
		await h.run();
		const check = h.root.querySelector<HTMLInputElement>(".bstask__check");
		expect(check?.checked).toBe(false);
		expect(h.root.querySelector(".bstask__title")?.textContent).toBe("Ship v1 spec");
		expect(h.root.querySelector(".bstask__due")?.textContent).toBeTruthy();
		expect(h.root.classList.contains("bstask--done")).toBe(false);
	});

	it("renders a completed task as done (struck through)", async () => {
		const h = makeCtx({
			entityId: "task-1",
			entityTypeId: TASK_TYPE,
			properties: { name: "Draft brief", completedAt: 123 },
			updatedAt: 1,
		});
		await h.run();
		expect(h.root.querySelector<HTMLInputElement>(".bstask__check")?.checked).toBe(true);
		expect(h.root.classList.contains("bstask--done")).toBe(true);
	});

	it("toggling the checkbox writes the done state via updateEntity", async () => {
		const h = makeCtx({
			entityId: "task-1",
			entityTypeId: TASK_TYPE,
			properties: { name: "Ship v1 spec" },
			updatedAt: 1,
		});
		await h.run();
		const check = h.root.querySelector<HTMLInputElement>(".bstask__check");
		if (!check) throw new Error("no checkbox");
		check.checked = true;
		check.dispatchEvent(new Event("change"));
		const call = h.graph.mock.calls.find((c) => c[0] === "updateEntity");
		expect(call).toBeTruthy();
		const arg = call?.[1] as {
			entityId: string;
			entityTypeId: string;
			properties: Record<string, unknown>;
		};
		expect(arg.entityId).toBe("task-1");
		expect(arg.entityTypeId).toBe(TASK_TYPE);
		expect(arg.properties.statusKey).toBe("done");
		expect(typeof arg.properties.completedAt).toBe("number");
	});

	it("clicking the title navigates to the task", async () => {
		const h = makeCtx({
			entityId: "task-1",
			entityTypeId: TASK_TYPE,
			properties: { name: "Ship v1 spec" },
			updatedAt: 1,
		});
		await h.run();
		h.root.querySelector<HTMLElement>(".bstask__title")?.click();
		expect(h.navigate).toHaveBeenCalledWith("task-1", TASK_TYPE);
	});

	it("shows an error when the task can't be loaded", async () => {
		const root = document.createElement("div");
		document.body.appendChild(root);
		const held: { loader: (() => void | Promise<void>) | null } = { loader: null };
		const ctx = {
			entityId: "task-1",
			capabilities: () => [],
			root,
			graph: (async () => {
				throw new Error("denied");
			}) as unknown as <T>(m: string, d: unknown) => Promise<T>,
			navigate: vi.fn(),
			reportHeight: vi.fn(),
			onLoad: (run: () => void | Promise<void>) => {
				held.loader = run;
			},
		} satisfies BlockRuntimeContext;
		bootInlineTask(ctx);
		await held.loader?.();
		expect(root.querySelector(".bstask__error")).not.toBeNull();
	});
});

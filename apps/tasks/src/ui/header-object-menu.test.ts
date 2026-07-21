// @vitest-environment jsdom
import type { ObjectMenuRuntime } from "@brainstorm-os/sdk/object-menu";
import { describe, expect, it } from "vitest";
import type { Project } from "../types/project";
import { Priority, type Task } from "../types/task";
import {
	paintTasksHeaderRight,
	projectHeaderMenuContext,
	taskHeaderMenuContext,
} from "./header-object-menu";

function project(overrides: Partial<Project>): Project {
	return {
		id: "proj_test",
		name: "Test",
		statusKey: null,
		milestoneAt: null,
		colorHint: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function task(overrides: Partial<Task>): Task {
	return {
		id: "task_test",
		name: "Test task",
		completedAt: null,
		priority: Priority.None,
		scheduledAt: null,
		dueAt: null,
		projectId: null,
		assigneeId: null,
		parentId: null,
		recurrence: null,
		statusKey: null,
		sortIndex: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

const RUNTIME: ObjectMenuRuntime = {
	openIntent: () => Promise.resolve(),
	pin: () => Promise.resolve(),
	unpin: () => Promise.resolve(),
	isPinned: () => Promise.resolve(false),
	capabilities: ["dashboard.pin", "intents.dispatch:open"],
} as unknown as ObjectMenuRuntime;

describe("projectHeaderMenuContext", () => {
	it("targets the project with delete wiring when onRemove is provided", () => {
		const ctx = projectHeaderMenuContext({
			project: project({}),
			runtime: RUNTIME,
			onRemove: () => {},
		});
		expect(ctx?.target.entityId).toBe("proj_test");
		expect(ctx?.onRemove).toBeDefined();
		expect(ctx?.extraItems).toBeUndefined();
		// The surface already shows this project — the header ⋯ drops "Open".
		expect(ctx?.omitOpen).toBe(true);
	});

	it("returns null when the runtime is null (preview / no shell)", () => {
		const ctx = projectHeaderMenuContext({
			project: project({}),
			runtime: null,
		});
		expect(ctx).toBeNull();
	});
});

describe("taskHeaderMenuContext", () => {
	it("targets the open task with delete wiring when onRemove is provided", () => {
		const ctx = taskHeaderMenuContext({
			task: task({}),
			runtime: RUNTIME,
			onRemove: () => {},
		});
		expect(ctx?.target.entityId).toBe("task_test");
		expect(ctx?.target.label).toBe("Test task");
		expect(ctx?.onRemove).toBeDefined();
		// The detail route IS the open task — the header ⋯ drops "Open".
		expect(ctx?.omitOpen).toBe(true);
	});

	it("returns null when the runtime is null (preview / no shell)", () => {
		const ctx = taskHeaderMenuContext({ task: task({}), runtime: null });
		expect(ctx).toBeNull();
	});
});

describe("paintTasksHeaderRight", () => {
	function container(): HTMLElement {
		const el = document.createElement("div");
		el.className = "app-header__right";
		return el;
	}

	it("places the given ⋯ LAST after actions and toggles", () => {
		const right = container();
		const action = document.createElement("button");
		const toggle = document.createElement("button");
		const more = document.createElement("button");
		more.className = "bs-object-menu__more";
		paintTasksHeaderRight(right, [action, toggle], more);
		expect([...right.children]).toEqual([action, toggle, more]);
		expect(right.lastElementChild?.classList.contains("bs-object-menu__more")).toBe(true);
	});

	it("renders a disabled ⋯ LAST when the surface has no object menu", () => {
		const right = container();
		const action = document.createElement("button");
		paintTasksHeaderRight(right, [action, null], null);
		const last = right.lastElementChild as HTMLButtonElement;
		expect(last.classList.contains("bs-object-menu__more")).toBe(true);
		// F-271: the unavailable ⋯ uses aria-disabled (NOT native `disabled`) so it
		// stays hoverable/focusable for its explanatory tooltip.
		expect(last.disabled).toBe(false);
		expect(last.getAttribute("aria-disabled")).toBe("true");
	});
});

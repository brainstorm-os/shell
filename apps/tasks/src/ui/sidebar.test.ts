/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../types/project";
import { TaskSurface } from "../types/surface";
import { type SidebarProps, applyProjectReorder, renderSidebar, sortProjects } from "./sidebar";

function project(overrides: Partial<Project> & { id: string }): Project {
	const { id, name, ...rest } = overrides;
	return {
		id,
		name: name ?? id,
		statusKey: null,
		milestoneAt: null,
		colorHint: null,
		createdAt: 0,
		updatedAt: 0,
		...rest,
	};
}

describe("sortProjects — sidebar ordering", () => {
	it("sorts by manual sortIndex first, then by createdAt — manual order wins", () => {
		const list = [
			project({ id: "first_created", createdAt: 1, sortIndex: 2 }),
			project({ id: "mid_created", createdAt: 5, sortIndex: 0 }),
			project({ id: "last_created", createdAt: 10, sortIndex: 1 }),
		];
		expect(sortProjects(list).map((p) => p.id)).toEqual([
			"mid_created",
			"last_created",
			"first_created",
		]);
	});

	it("falls back to createdAt asc for projects without a sortIndex", () => {
		const list = [
			project({ id: "old", createdAt: 1 }),
			project({ id: "new", createdAt: 100 }),
			project({ id: "mid", createdAt: 50 }),
		];
		expect(sortProjects(list).map((p) => p.id)).toEqual(["old", "mid", "new"]);
	});

	it("places indexed projects before any unindexed ones — partial reorder stays readable", () => {
		const list = [
			project({ id: "unindexed_old", createdAt: 1 }),
			project({ id: "indexed", createdAt: 2, sortIndex: 0 }),
			project({ id: "unindexed_new", createdAt: 3 }),
		];
		expect(sortProjects(list).map((p) => p.id)).toEqual([
			"indexed",
			"unindexed_old",
			"unindexed_new",
		]);
	});
});

describe("applyProjectReorder — pure move helper", () => {
	const projects: Project[] = ["a", "b", "c", "d"].map((id) => project({ id })) as Project[];
	const ids = projects.map((p) => p.id);

	it("moves a row before its drop target", () => {
		expect(applyProjectReorder(ids, "d", "b")).toEqual(["a", "d", "b", "c"]);
	});

	it("moves a row to the end when targetId is null", () => {
		expect(applyProjectReorder(ids, "a", null)).toEqual(["b", "c", "d", "a"]);
	});

	it("is a no-op when the drag and the drop position collapse to the same slot", () => {
		expect(applyProjectReorder(ids, "b", "b")).toEqual(ids);
	});

	it("returns the input untouched if the dragged id isn't in the list", () => {
		expect(applyProjectReorder(ids, "missing", "b")).toEqual(ids);
	});

	it("returns the input untouched if the target id isn't in the list", () => {
		expect(applyProjectReorder(ids, "a", "missing")).toEqual(ids);
	});
});

describe("renderSidebar — create project + inline rename (F-035)", () => {
	function baseProps(over: Partial<SidebarProps> = {}): SidebarProps {
		return {
			projects: [project({ id: "p1", name: "Getting started", createdAt: 1 })],
			selection: { kind: TaskSurface.Today },
			counts: new Map(),
			onSelect: vi.fn(),
			objectMenuEnabled: false,
			...over,
		};
	}

	it("shows a New-project affordance by the heading only when onCreateProject is provided", () => {
		const without = renderSidebar(baseProps());
		expect(without.querySelector(".tasks-sidebar__heading-add")).toBeNull();

		const onCreateProject = vi.fn();
		const withAdd = renderSidebar(baseProps({ onCreateProject }));
		const add = withAdd.querySelector<HTMLButtonElement>(".tasks-sidebar__heading-add");
		expect(add).not.toBeNull();
		add?.click();
		expect(onCreateProject).toHaveBeenCalledTimes(1);
	});

	it("renders the renaming project's row as a focused input seeded with its name", () => {
		const aside = renderSidebar(baseProps({ renamingProjectId: "p1", onRenameProject: vi.fn() }));
		const input = aside.querySelector<HTMLInputElement>(".tasks-sidebar__rename-input");
		expect(input).not.toBeNull();
		expect(input?.value).toBe("Getting started");
		// The project's static row label is replaced while renaming (built-in
		// surface rows keep theirs, so scope the check to the projects group).
		expect(aside.querySelector(".tasks-sidebar__group--projects .tasks-sidebar__label")).toBeNull();
	});

	it("commits the typed name on Enter and cancels (keeps name) on Escape", async () => {
		const onRenameProject = vi.fn();
		const aside = renderSidebar(baseProps({ renamingProjectId: "p1", onRenameProject }));
		const input = aside.querySelector<HTMLInputElement>(".tasks-sidebar__rename-input");
		if (!input) throw new Error("no rename input");
		input.value = "Newsletter";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		// The rename is deferred out of the key/blur dispatch (F-254).
		await Promise.resolve();
		expect(onRenameProject).toHaveBeenCalledWith("p1", "Newsletter");

		const aside2 = renderSidebar(
			baseProps({ renamingProjectId: "p1", onRenameProject: (id, name) => onRenameProject(id, name) }),
		);
		const input2 = aside2.querySelector<HTMLInputElement>(".tasks-sidebar__rename-input");
		input2?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		// Escape commits an empty string → the app keeps the existing name.
		await Promise.resolve();
		expect(onRenameProject).toHaveBeenLastCalledWith("p1", "");
	});
});

describe("renderSidebar — KBN-A roving listbox (12.4)", () => {
	function nav(over: Partial<SidebarProps> = {}): SidebarProps {
		return {
			projects: [
				project({ id: "p1", name: "Alpha", createdAt: 1, sortIndex: 0 }),
				project({ id: "p2", name: "Bravo", createdAt: 2, sortIndex: 1 }),
			],
			selection: { kind: TaskSurface.Today },
			counts: new Map(),
			onSelect: vi.fn(),
			objectMenuEnabled: false,
			...over,
		};
	}

	it("stamps a listbox over every navigable row (binding-owned roles)", () => {
		const aside = renderSidebar(nav());
		expect(aside.getAttribute("role")).toBe("listbox");
		expect(aside.getAttribute("aria-orientation")).toBe("vertical");
		const rows = aside.querySelectorAll<HTMLElement>(".tasks-sidebar__row[data-composite-index]");
		// 5 built-in surfaces + 2 projects.
		expect(rows).toHaveLength(7);
		expect(rows[0]?.getAttribute("role")).toBe("option");
		// Headings carry no composite index, so the binding skips them.
		expect(aside.querySelector(".tasks-sidebar__heading[data-composite-index]")).toBeNull();
	});

	it("seeds the cursor on the active surface (Today is the 2nd built-in row)", () => {
		const aside = renderSidebar(nav({ selection: { kind: TaskSurface.Today } }));
		const rows = aside.querySelectorAll<HTMLElement>(".tasks-sidebar__row[data-composite-index]");
		// BUILTIN order: Inbox, Today, Upcoming, Board, Timeline → Today is index 1.
		expect(rows[1]?.tabIndex).toBe(0);
		expect(rows[1]?.getAttribute("aria-current")).toBe("true");
		expect(rows[0]?.tabIndex).toBe(-1);
	});

	it("ArrowDown roves focus without switching surface; Enter commits the focused surface", () => {
		const onSelect = vi.fn();
		const aside = renderSidebar(nav({ selection: { kind: TaskSurface.Inbox }, onSelect }));
		document.body.appendChild(aside);
		// Inbox is index 0 → ArrowDown moves to Today (index 1). Roving alone
		// must NOT select.
		aside.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(onSelect).not.toHaveBeenCalled();
		// Enter commits the now-focused Today surface.
		aside.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect.mock.calls[0]?.[0]).toEqual({ kind: TaskSurface.Today });
		document.body.replaceChildren();
	});

	it("a project row commits its project selection on Enter", () => {
		const onSelect = vi.fn();
		const aside = renderSidebar(
			nav({ selection: { kind: TaskSurface.Project, projectId: "p2" }, onSelect }),
		);
		document.body.appendChild(aside);
		// p2 is the last navigable row (index 5) and is the active selection, so
		// the cursor seeds there. Enter re-commits it.
		aside.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(onSelect).toHaveBeenCalledWith({ kind: TaskSurface.Project, projectId: "p2" });
		document.body.replaceChildren();
	});

	it("does not steal keys while a project row is mid inline-rename", () => {
		const onSelect = vi.fn();
		const aside = renderSidebar(nav({ renamingProjectId: "p1", onRenameProject: vi.fn(), onSelect }));
		const input = aside.querySelector<HTMLInputElement>(".tasks-sidebar__rename-input");
		if (!input) throw new Error("no rename input");
		// The rename row carries no composite index → the binding ignores its keys.
		const renameRow = input.closest(".tasks-sidebar__item");
		expect(renameRow?.querySelector("[data-composite-index]")).toBeNull();
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(onSelect).not.toHaveBeenCalled();
	});
});

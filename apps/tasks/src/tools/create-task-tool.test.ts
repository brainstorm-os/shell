/**
 * The Tasks `create-task` tool handler (Tool-10) — the last code before a
 * write, so every refusal is asserted to leave the store untouched.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../types/task";
import {
	CREATE_TASK_NAME_MAX,
	CREATE_TASK_SOURCE_ARG,
	CREATE_TASK_SOURCE_TYPES,
	CREATE_TASK_TOOL,
	type CreateTaskToolDeps,
	CreateTaskToolError,
	runCreateTaskTool,
	taskNameFromTitle,
} from "./create-task-tool";

const NOTE_TYPE = "io.brainstorm.notes/Note/v1";
const NOW = Date.UTC(2026, 10, 19, 9, 0, 0);

function deps(over: Partial<CreateTaskToolDeps> = {}): CreateTaskToolDeps & { written: Task[] } {
	const written: Task[] = [];
	return {
		written,
		getEntity: async (id) =>
			id === "n1" ? { type: NOTE_TYPE, properties: { title: "Plan the offsite" } } : null,
		createTask: async (task) => {
			written.push(task);
		},
		newId: () => "task-1",
		now: () => NOW,
		untitledName: () => "Untitled task",
		describeSource: (title) => `From “${title}”`,
		...over,
	};
}

describe("create-task tool handler", () => {
	it("creates one task named after the source note", async () => {
		const d = deps();
		const out = await runCreateTaskTool({ source: "n1" }, d);
		expect(out).toEqual({ taskId: "task-1", name: "Plan the offsite" });
		expect(d.written).toHaveLength(1);
		expect(d.written[0]).toMatchObject({
			id: "task-1",
			name: "Plan the offsite",
			notes: "From “Plan the offsite”",
			completedAt: null,
			projectId: null,
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	it("names an untitled source with the localised fallback and adds no notes", async () => {
		const d = deps({ getEntity: async () => ({ type: NOTE_TYPE, properties: { title: "  " } }) });
		const out = await runCreateTaskTool({ source: "n1" }, d);
		expect(out.name).toBe("Untitled task");
		expect(d.written[0]?.notes).toBeUndefined();
	});

	it.each([
		["no bag", undefined],
		["null", null],
		["an array", ["n1"]],
		["a missing key", {}],
		["a non-string id", { source: 7 }],
		["an empty id", { source: "" }],
		["an over-long id", { source: "x".repeat(257) }],
		["an inherited key", Object.create({ source: "n1" })],
	])("refuses %s without reading or writing anything", async (_label, args) => {
		const getEntity = vi.fn(async () => ({ type: NOTE_TYPE, properties: {} }));
		const d = deps({ getEntity });
		await expect(runCreateTaskTool(args, d)).rejects.toThrow(CreateTaskToolError.BadArguments);
		expect(getEntity).not.toHaveBeenCalled();
		expect(d.written).toEqual([]);
	});

	it("reads the argument exactly once (a getter cannot swap the id after the check)", async () => {
		let reads = 0;
		const args = {
			get source() {
				reads += 1;
				return reads === 1 ? "n1" : "other";
			},
		};
		const seen: string[] = [];
		const d = deps({
			getEntity: async (id) => {
				seen.push(id);
				return { type: NOTE_TYPE, properties: { title: "T" } };
			},
		});
		await runCreateTaskTool(args, d);
		expect(reads).toBe(1);
		expect(seen).toEqual(["n1"]);
	});

	it("refuses a source of another type even if the broker let it through", async () => {
		const d = deps({
			getEntity: async () => ({ type: "brainstorm/Secret/v1", properties: { title: "Payroll" } }),
		});
		await expect(runCreateTaskTool({ source: "n1" }, d)).rejects.toThrow(
			CreateTaskToolError.SourceUnavailable,
		);
		expect(d.written).toEqual([]);
	});

	it("answers a missing and an unreadable source identically", async () => {
		const missing = deps();
		const unreadable = deps({
			getEntity: async () => {
				throw new Error("Denied: io.brainstorm.tasks lacks entities.read:x — secret detail");
			},
		});
		for (const d of [missing, unreadable]) {
			const error = await runCreateTaskTool({ source: "nope" }, d).catch((e: unknown) => e);
			expect((error as Error).message).toBe(CreateTaskToolError.SourceUnavailable);
			expect(d.written).toEqual([]);
		}
	});

	it("rejects when the write did not land, without leaking the store's message", async () => {
		const d = deps({
			createTask: async () => {
				throw new Error("UNIQUE constraint failed: entities.id (Plan the offsite)");
			},
		});
		const error = await runCreateTaskTool({ source: "n1" }, d).catch((e: unknown) => e);
		expect((error as Error).message).toBe(CreateTaskToolError.NotWritten);
	});

	it("flattens and caps a title into a one-line task name", () => {
		expect(taskNameFromTitle("  Line one\n\tline two  ")).toBe("Line one line two");
		const long = taskNameFromTitle("𝒳".repeat(CREATE_TASK_NAME_MAX + 50));
		expect(Array.from(long)).toHaveLength(CREATE_TASK_NAME_MAX);
		// Cut on a code point, never mid surrogate pair.
		expect(long.endsWith("𝒳")).toBe(true);
	});
});

describe("create-task declaration ↔ handler", () => {
	const manifest = JSON.parse(
		readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "manifest.json"), "utf8"),
	) as {
		capabilities: string[];
		registrations: {
			tools: Array<{
				name: string;
				effect: string;
				appliesTo: string[];
				surfaces: string[];
				input: Array<{ name: string; required: boolean; valueType: string; allowedTypes: string[] }>;
			}>;
		};
	};

	it("the manifest declares exactly the tool the handler answers", () => {
		expect(manifest.registrations.tools).toHaveLength(1);
		const tool = manifest.registrations.tools[0];
		expect(tool?.name).toBe(CREATE_TASK_TOOL);
		expect(tool?.effect).toBe("writes-vault");
		expect(tool?.surfaces).toEqual(["menu"]);
		expect(tool?.appliesTo).toEqual([...CREATE_TASK_SOURCE_TYPES]);
		expect(tool?.input).toEqual([
			expect.objectContaining({
				name: CREATE_TASK_SOURCE_ARG,
				required: true,
				valueType: "entityRef",
				allowedTypes: [...CREATE_TASK_SOURCE_TYPES],
			}),
		]);
	});

	it("Tasks holds the provider grant and the write grant its effect requires", () => {
		expect(manifest.capabilities).toContain("tools.provide");
		expect(manifest.capabilities).toContain("entities.write:brainstorm/Task/v1");
		// A provider never needs to CALL — no `tools.call` rides along.
		expect(manifest.capabilities.some((c) => c.startsWith("tools.call"))).toBe(false);
	});
});

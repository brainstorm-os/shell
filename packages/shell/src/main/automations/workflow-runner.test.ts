import {
	type BranchStep,
	type ForEachStep,
	type NotifyStep,
	type WorkflowRunStatus as RunStatus,
	StepKind,
	WorkflowRunStatus,
	type WorkflowStep,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	type InterpreterRegistry,
	type StepInterpreter,
	StepRunStatus,
	TIMEOUT_ABORT_REASON,
	WorkflowRunner,
	type WorkflowRunnerOptions,
	toWorkflowRunDef,
} from "./workflow-runner";

/** A monotonic clock so durations/timestamps are deterministic. */
function fakeClock(start = 1000, step = 10): () => number {
	let t = start;
	return () => {
		const now = t;
		t += step;
		return now;
	};
}

/** An interpreter that always succeeds, recording the step it saw. */
const okInterpreter =
	(output: unknown = "ok"): StepInterpreter =>
	async () => ({ ok: true, output });

function notify(id: string, title = "t"): NotifyStep {
	return { id, kind: StepKind.Notify, title };
}

function run(
	steps: WorkflowStep[],
	interpreters: InterpreterRegistry,
	opts: WorkflowRunnerOptions = {},
	extra: { triggerPayload?: unknown; signal?: AbortSignal } = {},
) {
	return new WorkflowRunner(interpreters, { clock: fakeClock(), ...opts }).run({
		workflowId: "wf1",
		triggeredBy: "fire1",
		steps,
		...extra,
	});
}

describe("WorkflowRunner — the interpreter loop + provenance", () => {
	it("runs steps in order and logs each one succeeded", async () => {
		const seen: string[] = [];
		const rec: StepInterpreter = async (step) => {
			seen.push(step.id);
			return { ok: true, output: step.id };
		};
		const result = await run([notify("a"), notify("b"), notify("c")], {
			[StepKind.Notify]: rec,
		});
		expect(seen).toEqual(["a", "b", "c"]);
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
		expect(result.stepLog.map((e) => [e.stepId, e.status])).toEqual([
			["a", StepRunStatus.Succeeded],
			["b", StepRunStatus.Succeeded],
			["c", StepRunStatus.Succeeded],
		]);
		expect(result.error).toBeUndefined();
	});

	it("an empty workflow succeeds with an empty log", async () => {
		const result = await run([], {});
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
		expect(result.stepLog).toEqual([]);
	});

	it("seeds the trigger step's output with the fire payload", async () => {
		let triggerOut: unknown;
		const reader: StepInterpreter = async (_step, ctx) => {
			triggerOut = ctx.outputs.get("trig");
			return { ok: true, output: null };
		};
		await run(
			[{ id: "trig", kind: StepKind.Trigger }, notify("n")],
			{ [StepKind.Notify]: reader },
			{},
			{ triggerPayload: { entityId: "e9" } },
		);
		expect(triggerOut).toEqual({ entityId: "e9" });
	});

	it("a later step sees an earlier step's output", async () => {
		let seenInput: unknown;
		const first: StepInterpreter = async () => ({ ok: true, output: 42 });
		const second: StepInterpreter = async (_s, ctx) => {
			seenInput = ctx.outputs.get("a");
			return { ok: true, output: null };
		};
		await run([{ ...notify("a") }, { ...notify("b") }], {
			// route by id via a dispatcher
			[StepKind.Notify]: async (step, ctx) => (step.id === "a" ? first(step, ctx) : second(step, ctx)),
		});
		expect(seenInput).toBe(42);
	});

	it("records provenance timestamps, duration, and attempts", async () => {
		const result = await run([notify("a")], { [StepKind.Notify]: okInterpreter() });
		const entry = result.stepLog[0];
		expect(entry).toMatchObject({ attempts: 1, durationMs: 10, status: StepRunStatus.Succeeded });
		expect(typeof entry?.startedAt).toBe("number");
	});
});

describe("WorkflowRunner — failure semantics (doc 39 §Failure modes)", () => {
	it("a thrown error fails the run, skips downstream, and carries the message", async () => {
		const result = await run([notify("a"), notify("b"), notify("c")], {
			[StepKind.Notify]: async (step) => {
				if (step.id === "b") throw new Error("boom");
				return { ok: true, output: null };
			},
		});
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toBe("boom");
		expect(result.stepLog.map((e) => e.status)).toEqual([
			StepRunStatus.Succeeded,
			StepRunStatus.Failed,
			StepRunStatus.Skipped,
		]);
	});

	it("a returned non-retriable failure halts the run", async () => {
		const result = await run([notify("a"), notify("b")], {
			[StepKind.Notify]: async (step) =>
				step.id === "a" ? { ok: false, error: "denied" } : { ok: true, output: null },
		});
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toBe("denied");
		expect(result.stepLog[1]?.status).toBe(StepRunStatus.Skipped);
	});

	it("a step kind with no interpreter fails cleanly (gated kind)", async () => {
		const result = await run([{ id: "x", kind: StepKind.AICall, instructions: "hi" }], {});
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toBe(`unsupported-step-kind:${StepKind.AICall}`);
	});
});

describe("WorkflowRunner — retry policy", () => {
	it("retries a retriable failure up to maxAttempts, then succeeds", async () => {
		let calls = 0;
		const result = await run(
			[notify("a")],
			{
				[StepKind.Notify]: async () => {
					calls++;
					return calls < 3
						? { ok: false, error: "transient", retriable: true }
						: { ok: true, output: "done" };
				},
			},
			{ retry: { maxAttempts: 3 } },
		);
		expect(calls).toBe(3);
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
		expect(result.stepLog[0]?.attempts).toBe(3);
	});

	it("gives up after maxAttempts retriable failures and fails the run", async () => {
		let calls = 0;
		const result = await run(
			[notify("a")],
			{
				[StepKind.Notify]: async () => {
					calls++;
					return { ok: false, error: "always", retriable: true };
				},
			},
			{ retry: { maxAttempts: 2 } },
		);
		expect(calls).toBe(2);
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.stepLog[0]?.attempts).toBe(2);
	});

	it("does not retry a non-retriable failure", async () => {
		let calls = 0;
		await run(
			[notify("a")],
			{
				[StepKind.Notify]: async () => {
					calls++;
					return { ok: false, error: "fatal" };
				},
			},
			{ retry: { maxAttempts: 5 } },
		);
		expect(calls).toBe(1);
	});

	it("sleeps the computed backoff between attempts", async () => {
		const sleep = vi.fn(async () => {});
		let calls = 0;
		await run(
			[notify("a")],
			{
				[StepKind.Notify]: async () => {
					calls++;
					return calls < 3 ? { ok: false, error: "t", retriable: true } : { ok: true, output: null };
				},
			},
			{ retry: { maxAttempts: 3, backoffMs: (n) => n * 100 }, sleep },
		);
		expect(sleep.mock.calls).toEqual([[100], [200]]);
	});
});

describe("WorkflowRunner — cancellation & timeout", () => {
	it("an already-aborted run skips everything and is cancelled", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		const result = await run(
			[notify("a"), notify("b")],
			{ [StepKind.Notify]: okInterpreter() },
			{},
			{
				signal: ctrl.signal,
			},
		);
		expect(result.status).toBe(WorkflowRunStatus.Cancelled);
		expect(result.stepLog.every((e) => e.status === StepRunStatus.Skipped)).toBe(true);
	});

	it("aborting between steps cancels and skips the rest", async () => {
		const ctrl = new AbortController();
		const result = await run(
			[notify("a"), notify("b"), notify("c")],
			{
				[StepKind.Notify]: async (step) => {
					if (step.id === "a") ctrl.abort();
					return { ok: true, output: null };
				},
			},
			{},
			{ signal: ctrl.signal },
		);
		expect(result.status).toBe(WorkflowRunStatus.Cancelled);
		expect(result.stepLog.map((e) => e.status)).toEqual([
			StepRunStatus.Succeeded,
			StepRunStatus.Skipped,
			StepRunStatus.Skipped,
		]);
	});

	it("a timeout-reason abort maps to timed-out", async () => {
		const ctrl = new AbortController();
		ctrl.abort(TIMEOUT_ABORT_REASON);
		const result = await run(
			[notify("a")],
			{ [StepKind.Notify]: okInterpreter() },
			{},
			{
				signal: ctrl.signal,
			},
		);
		expect(result.status).toBe(WorkflowRunStatus.TimedOut);
	});
});

describe("WorkflowRunner — container steps via runChildren", () => {
	// A minimal Branch interpreter (11b.4 ships the real one) that runs the
	// consequent and folds the child status into its own outcome.
	const branchInterpreter: StepInterpreter = async (step, ctx) => {
		const branch = step as BranchStep;
		const child = await ctx.runChildren(branch.consequent);
		return child.status === WorkflowRunStatus.Succeeded
			? { ok: true, output: null }
			: { ok: false, error: "branch-body-failed" };
	};

	function branch(id: string, body: WorkflowStep[]): BranchStep {
		return { id, kind: StepKind.Branch, condition: "true", consequent: body };
	}

	it("runs a branch body and tags nested entries with depth", async () => {
		const result = await run([branch("b", [notify("x"), notify("y")])], {
			[StepKind.Branch]: branchInterpreter,
			[StepKind.Notify]: okInterpreter(),
		});
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
		// Children appear (depth 1) in chronological order, then the container.
		expect(result.stepLog.map((e) => [e.stepId, e.depth])).toEqual([
			["x", 1],
			["y", 1],
			["b", 0],
		]);
	});

	it("a failing nested step fails the container and the whole run", async () => {
		const result = await run([branch("b", [notify("x")]), notify("after")], {
			[StepKind.Branch]: branchInterpreter,
			[StepKind.Notify]: async (step) =>
				step.id === "x" ? { ok: false, error: "child-denied" } : { ok: true, output: null },
		});
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		const byId = Object.fromEntries(result.stepLog.map((e) => [e.stepId, e.status]));
		expect(byId.x).toBe(StepRunStatus.Failed);
		expect(byId.b).toBe(StepRunStatus.Failed);
		expect(byId.after).toBe(StepRunStatus.Skipped);
	});

	it("a forEach interpreter can drive its body repeatedly", async () => {
		const ran: string[] = [];
		const forEachInterpreter: StepInterpreter = async (step, ctx) => {
			const fe = step as ForEachStep;
			for (let i = 0; i < 3; i++) {
				const r = await ctx.runChildren(fe.body);
				if (r.status !== WorkflowRunStatus.Succeeded) return { ok: false, error: "iter-failed" };
			}
			return { ok: true, output: null };
		};
		const fe: ForEachStep = {
			id: "fe",
			kind: StepKind.ForEach,
			collection: "items",
			body: [notify("item")],
		};
		await run([fe], {
			[StepKind.ForEach]: forEachInterpreter,
			[StepKind.Notify]: async (step) => {
				ran.push(step.id);
				return { ok: true, output: null };
			},
		});
		expect(ran).toEqual(["item", "item", "item"]);
	});

	it("seeds a child with an explicit `undefined` item, not the container input", async () => {
		// Regression: `runChildren(body, { input })` signals seeding by the
		// wrapper's presence — an item of exactly `undefined` seeds `undefined`,
		// not the container's own input (which a default-param fallback would do).
		const seen: unknown[] = [];
		const container: StepInterpreter = async (_step, ctx) => {
			// container's own input is 99 (the prior step's output); it seeds the
			// child with an explicit undefined instead.
			await ctx.runChildren([notify("child")], { input: undefined });
			return { ok: true, output: null };
		};
		await run([notify("seed"), branch("c", [])], {
			[StepKind.Notify]: async (step, ctx) => {
				if (step.id === "child") {
					seen.push(ctx.input);
					return { ok: true, output: null };
				}
				return { ok: true, output: 99 }; // 'seed' → container input = 99
			},
			[StepKind.Branch]: container,
		});
		expect(seen).toEqual([undefined]);
	});
});

describe("toWorkflowRunDef", () => {
	it("maps a finished run into the WorkflowRun/v1 shape", async () => {
		const result = await run([notify("a")], { [StepKind.Notify]: okInterpreter() });
		const def = toWorkflowRunDef(result);
		expect(def).toMatchObject({
			workflow: "wf1",
			triggeredBy: "fire1",
			status: WorkflowRunStatus.Succeeded as RunStatus,
		});
		expect(def.triggeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(def.stepLog).toBe(result.stepLog);
		expect(def.error).toBeUndefined();
	});

	it("carries the error on a failed run", async () => {
		const result = await run([notify("a")], {
			[StepKind.Notify]: async () => ({ ok: false, error: "nope" }),
		});
		expect(toWorkflowRunDef(result).error).toBe("nope");
	});
});

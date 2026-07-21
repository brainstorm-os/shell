import {
	type BranchStep,
	EntityOp,
	type EntityStep,
	type ForEachStep,
	type IntentStep,
	type NotifyStep,
	StepKind,
	type SubWorkflowStep,
	type WaitStep,
	WorkflowRunStatus,
	type WorkflowStep,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	type EntitiesPort,
	type EntityRecord,
	type HttpStepRequest,
	type InterpreterPorts,
	createCoreInterpreters,
	defaultCollectionResolver,
	defaultConditionEvaluator,
} from "./step-interpreters";
import { WorkflowRunner } from "./workflow-runner";

function entity(id: string, type = "Note/v1"): EntityRecord {
	return { id, type, properties: { id } };
}

function fakeEntities(): EntitiesPort {
	return {
		create: vi.fn(async (type, properties) => ({ id: "new1", type, properties })),
		update: vi.fn(async (id, patch) => ({ id, type: "Note/v1", properties: patch })),
		get: vi.fn(async (id) => entity(id)),
		query: vi.fn(async () => [entity("q1"), entity("q2")]),
		delete: vi.fn(async () => {}),
	};
}

function ports(overrides: Partial<InterpreterPorts> = {}): InterpreterPorts {
	return {
		intents: { dispatch: vi.fn(async () => ({ handled: true })) },
		entities: fakeEntities(),
		notify: vi.fn(async () => {}),
		sleep: vi.fn(async () => {}),
		loadWorkflowSteps: vi.fn(async () => null),
		// The caps the running workflow's ports were built under — the ceiling
		// the SubWorkflow interpreter re-scopes a callee against (11b.6 gate 1).
		capabilities: ["notifications.post"],
		...overrides,
	};
}

/** Drive a single workflow through a real runner over the core interpreters. */
function runWith(p: InterpreterPorts, steps: WorkflowStep[], triggerPayload?: unknown) {
	const runner = new WorkflowRunner(createCoreInterpreters(p), {
		clock: (() => {
			let t = 0;
			return () => {
				t += 1;
				return t;
			};
		})(),
	});
	return runner.run({ workflowId: "wf1", triggeredBy: "fire1", steps, triggerPayload });
}

describe("Intent interpreter", () => {
	it("dispatches verb + entityType + args and outputs the result", async () => {
		const p = ports();
		const step: IntentStep = {
			id: "i",
			kind: StepKind.Intent,
			verb: "open",
			entityType: "Note/v1",
			args: { entityId: "e1" },
		};
		const result = await runWith(p, [step]);
		expect(p.intents.dispatch).toHaveBeenCalledWith("open", "Note/v1", { entityId: "e1" });
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
		expect(result.stepLog[0]?.output).toEqual({ handled: true });
	});
});

describe("Entity interpreter", () => {
	it("create uses the prior step's output as properties", async () => {
		const p = ports();
		const step: EntityStep = {
			id: "c",
			kind: StepKind.Entity,
			op: EntityOp.Create,
			entityType: "Note/v1",
		};
		await runWith(p, [{ id: "trig", kind: StepKind.Trigger }, step], { title: "Hi" });
		expect(p.entities.create).toHaveBeenCalledWith("Note/v1", { title: "Hi" });
	});

	it("update reads { id, patch } from input", async () => {
		const p = ports();
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const step: EntityStep = {
			id: "u",
			kind: StepKind.Entity,
			op: EntityOp.Update,
			entityType: "Note/v1",
		};
		await runWith(p, [trig, step], { id: "e9", patch: { done: true } });
		expect(p.entities.update).toHaveBeenCalledWith("e9", { done: true });
	});

	it("get / delete pull an id from a bare-string input", async () => {
		const p = ports();
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const get: EntityStep = {
			id: "g",
			kind: StepKind.Entity,
			op: EntityOp.Get,
			entityType: "Note/v1",
		};
		await runWith(p, [trig, get], "e7");
		expect(p.entities.get).toHaveBeenCalledWith("e7");
	});

	it("update fails cleanly when input carries no id", async () => {
		const p = ports();
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const step: EntityStep = {
			id: "u",
			kind: StepKind.Entity,
			op: EntityOp.Update,
			entityType: "Note/v1",
		};
		const result = await runWith(p, [trig, step], { nope: 1 });
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("entity-update-needs");
	});

	it("query passes an object input as the filter", async () => {
		const p = ports();
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const step: EntityStep = {
			id: "q",
			kind: StepKind.Entity,
			op: EntityOp.Query,
			entityType: "Note/v1",
		};
		const result = await runWith(p, [trig, step], { status: "open" });
		expect(p.entities.query).toHaveBeenCalledWith("Note/v1", { status: "open" });
		expect(result.stepLog[1]?.output).toHaveLength(2);
	});

	// 11b.6 security gate — runtime entity-type scope. The fake `get` returns a
	// "Note/v1" entity; a step declared on "Task/v1" must not be able to touch it.
	it("update refuses an entity whose fetched type is out of the step's scope", async () => {
		const p = ports();
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const step: EntityStep = {
			id: "u",
			kind: StepKind.Entity,
			op: EntityOp.Update,
			entityType: "Task/v1",
		};
		const result = await runWith(p, [trig, step], "note-1");
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("entity-update-out-of-scope");
		expect(p.entities.update).not.toHaveBeenCalled();
	});

	it("delete refuses an out-of-scope entity (delete is never called)", async () => {
		const p = ports();
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const step: EntityStep = {
			id: "d",
			kind: StepKind.Entity,
			op: EntityOp.Delete,
			entityType: "Task/v1",
		};
		const result = await runWith(p, [trig, step], "note-1");
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("entity-delete-out-of-scope");
		expect(p.entities.delete).not.toHaveBeenCalled();
	});

	it("get refuses to return an out-of-scope entity", async () => {
		const p = ports();
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const step: EntityStep = {
			id: "g",
			kind: StepKind.Entity,
			op: EntityOp.Get,
			entityType: "Task/v1",
		};
		const result = await runWith(p, [trig, step], "note-1");
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("entity-get-out-of-scope");
	});

	it("get returns null for a missing entity (no scope question to fail)", async () => {
		const p = ports({ entities: { ...fakeEntities(), get: vi.fn(async () => null) } });
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const step: EntityStep = {
			id: "g",
			kind: StepKind.Entity,
			op: EntityOp.Get,
			entityType: "Note/v1",
		};
		const result = await runWith(p, [trig, step], "gone");
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
		expect(result.stepLog[1]?.output).toBeNull();
	});

	it("update fails closed when the target entity is missing", async () => {
		const p = ports({ entities: { ...fakeEntities(), get: vi.fn(async () => null) } });
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const step: EntityStep = {
			id: "u",
			kind: StepKind.Entity,
			op: EntityOp.Update,
			entityType: "Note/v1",
		};
		const result = await runWith(p, [trig, step], "gone");
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("entity-update-not-found");
		expect(p.entities.update).not.toHaveBeenCalled();
	});
});

describe("Notify interpreter", () => {
	it("posts title/body/target", async () => {
		const p = ports();
		const step: NotifyStep = {
			id: "n",
			kind: StepKind.Notify,
			title: "Done",
			body: "ok",
			target: "e1",
		};
		await runWith(p, [step]);
		expect(p.notify).toHaveBeenCalledWith({ title: "Done", body: "ok", target: "e1" });
	});
});

describe("Wait interpreter", () => {
	it("sleeps the duration and passes input through", async () => {
		const p = ports();
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const step: WaitStep = { id: "w", kind: StepKind.Wait, durationMs: 500 };
		const result = await runWith(p, [trig, step], { carry: 1 });
		expect(p.sleep).toHaveBeenCalledWith(500);
		expect(result.stepLog[1]?.output).toEqual({ carry: 1 });
	});

	it("does not sleep for a zero/absent duration", async () => {
		const p = ports();
		const step: WaitStep = { id: "w", kind: StepKind.Wait };
		await runWith(p, [step]);
		expect(p.sleep).not.toHaveBeenCalled();
	});
});

describe("Branch interpreter", () => {
	function branch(
		consequent: WorkflowStep[],
		alternate?: WorkflowStep[],
		condition = "input",
	): BranchStep {
		return {
			id: "b",
			kind: StepKind.Branch,
			condition,
			consequent,
			...(alternate ? { alternate } : {}),
		};
	}

	it("runs the consequent when the condition holds (truthy input)", async () => {
		const p = ports();
		const note: NotifyStep = { id: "yes", kind: StepKind.Notify, title: "yes" };
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		await runWith(p, [trig, branch([note])], true);
		expect(p.notify).toHaveBeenCalledTimes(1);
	});

	it("runs the alternate when the condition is false", async () => {
		const p = ports();
		const yes: NotifyStep = { id: "yes", kind: StepKind.Notify, title: "yes" };
		const no: NotifyStep = { id: "no", kind: StepKind.Notify, title: "no" };
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		await runWith(p, [trig, branch([yes], [no])], false);
		expect(p.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "no" }));
		expect(p.notify).toHaveBeenCalledTimes(1);
	});

	it("a no-op when the taken branch is empty (passes input through)", async () => {
		const p = ports();
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const result = await runWith(p, [trig, branch([], undefined, "false")], { x: 1 });
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
		expect(result.stepLog.find((e) => e.stepId === "b")?.output).toEqual({ x: 1 });
	});

	it("evaluates an expression condition through the sandbox grammar (11b.9)", async () => {
		const p = ports();
		const yes: NotifyStep = { id: "yes", kind: StepKind.Notify, title: "yes" };
		const no: NotifyStep = { id: "no", kind: StepKind.Notify, title: "no" };
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		await runWith(p, [trig, branch([yes], [no], "input.count > 3")], { count: 5 });
		expect(p.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "yes" }));
		expect(p.notify).toHaveBeenCalledTimes(1);
	});
});

describe("ForEach interpreter", () => {
	it("runs the body once per item", async () => {
		const p = ports();
		const body: NotifyStep = { id: "row", kind: StepKind.Notify, title: "row" };
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const fe: ForEachStep = { id: "fe", kind: StepKind.ForEach, collection: "input", body: [body] };
		const result = await runWith(p, [trig, fe], ["a", "b", "c"]);
		expect(p.notify).toHaveBeenCalledTimes(3);
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
	});

	it("resolves the collection via an expression (member access, 11b.9)", async () => {
		const p = ports();
		const body: NotifyStep = { id: "row", kind: StepKind.Notify, title: "row" };
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const fe: ForEachStep = {
			id: "fe",
			kind: StepKind.ForEach,
			collection: "input.rows",
			body: [body],
		};
		const result = await runWith(p, [trig, fe], { rows: ["a", "b"] });
		expect(p.notify).toHaveBeenCalledTimes(2);
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
	});

	it("seeds each iteration's first step with the current item", async () => {
		const seen: unknown[] = [];
		const p = ports({
			entities: {
				...fakeEntities(),
				create: vi.fn(async (_t, props) => {
					seen.push(props);
					return { id: "x", type: "T", properties: props };
				}),
			},
		});
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const create: EntityStep = {
			id: "c",
			kind: StepKind.Entity,
			op: EntityOp.Create,
			entityType: "T",
		};
		const fe: ForEachStep = { id: "fe", kind: StepKind.ForEach, collection: "input", body: [create] };
		await runWith(p, [trig, fe], [{ n: 1 }, { n: 2 }]);
		expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
	});

	it("fails the step if any iteration fails", async () => {
		const p = ports();
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		// Update with no id in the item → the body fails
		const upd: EntityStep = { id: "u", kind: StepKind.Entity, op: EntityOp.Update, entityType: "T" };
		const fe: ForEachStep = { id: "fe", kind: StepKind.ForEach, collection: "input", body: [upd] };
		const result = await runWith(p, [trig, fe], [{ no: "id" }]);
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.stepLog.find((e) => e.stepId === "fe")?.error).toBe("for-each-body-failed");
	});

	it("an empty collection is a no-op success with an empty result", async () => {
		const p = ports();
		const trig: WorkflowStep = { id: "trig", kind: StepKind.Trigger };
		const body: NotifyStep = { id: "row", kind: StepKind.Notify, title: "row" };
		const fe: ForEachStep = { id: "fe", kind: StepKind.ForEach, collection: "input", body: [body] };
		const result = await runWith(p, [trig, fe], []);
		expect(p.notify).not.toHaveBeenCalled();
		expect(result.stepLog.find((e) => e.stepId === "fe")?.output).toEqual([]);
	});
});

describe("SubWorkflow interpreter", () => {
	it("loads + runs the referenced workflow's steps", async () => {
		const subSteps: WorkflowStep[] = [{ id: "sub-n", kind: StepKind.Notify, title: "sub" }];
		const p = ports({
			loadWorkflowSteps: vi.fn(async () => ({
				steps: subSteps,
				capabilities: ["notifications.post"],
			})),
		});
		const step: SubWorkflowStep = { id: "sw", kind: StepKind.SubWorkflow, workflowId: "wf2" };
		const result = await runWith(p, [step]);
		expect(p.loadWorkflowSteps).toHaveBeenCalledWith("wf2");
		expect(p.notify).toHaveBeenCalledTimes(1);
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
	});

	it("fails cleanly when the sub-workflow is missing", async () => {
		const p = ports({ loadWorkflowSteps: vi.fn(async () => null) });
		const step: SubWorkflowStep = { id: "sw", kind: StepKind.SubWorkflow, workflowId: "gone" };
		const result = await runWith(p, [step]);
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toBe("sub-workflow-not-found:gone");
	});

	// 11b.6 security gate 1 — re-scope at the call boundary.
	it("refuses a callee whose steps exceed its OWN declared caps", async () => {
		// The callee notifies but declares no caps → its steps escape its consent.
		const subSteps: WorkflowStep[] = [{ id: "sub-n", kind: StepKind.Notify, title: "sub" }];
		const p = ports({
			loadWorkflowSteps: vi.fn(async () => ({ steps: subSteps, capabilities: [] })),
		});
		const step: SubWorkflowStep = { id: "sw", kind: StepKind.SubWorkflow, workflowId: "wf2" };
		const result = await runWith(p, [step]);
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("sub-workflow-capability-denied");
		// The callee's steps never run.
		expect(p.notify).not.toHaveBeenCalled();
	});

	it("refuses a callee whose declared caps exceed the caps in effect", async () => {
		// Empty steps (no step caps needed) but the callee declares a cap the
		// running ports (notifications.post) don't grant → denied via tier 2.
		const p = ports({
			capabilities: ["notifications.post"],
			loadWorkflowSteps: vi.fn(async () => ({ steps: [], capabilities: ["ai.use"] })),
		});
		const step: SubWorkflowStep = { id: "sw", kind: StepKind.SubWorkflow, workflowId: "wf2" };
		const result = await runWith(p, [step]);
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("sub-workflow-capability-denied:ai.use");
	});

	// 11b.6 gate 1 — nested re-scoping: A (post+ai) → B (declares post) → C.
	const nestedLoader = (cCaps: readonly string[], cSteps: WorkflowStep[]) =>
		vi.fn(async (id: string) => {
			if (id === "B")
				return {
					steps: [{ id: "callC", kind: StepKind.SubWorkflow, workflowId: "C" }] as WorkflowStep[],
					capabilities: ["notifications.post"],
				};
			if (id === "C") return { steps: cSteps, capabilities: cCaps };
			return null;
		});

	it("re-scopes a nested sub-workflow against the intermediate's caps, not the caller's", async () => {
		// C declares `ai.use` — within A's caps but NOT within B's. The narrowed
		// ceiling (B's caps) must deny it; with the old caller-wide ceiling it'd pass.
		const p = ports({
			capabilities: ["notifications.post", "ai.use"],
			loadWorkflowSteps: nestedLoader(["ai.use"], []),
		});
		const callB: SubWorkflowStep = { id: "callB", kind: StepKind.SubWorkflow, workflowId: "B" };
		const result = await runWith(p, [callB]);
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(
			result.stepLog.some((e) => e.error?.includes("sub-workflow-capability-denied:ai.use")),
		).toBe(true);
	});

	it("allows a nested sub-workflow within the intermediate's caps", async () => {
		const p = ports({
			capabilities: ["notifications.post"],
			loadWorkflowSteps: nestedLoader(
				["notifications.post"],
				[{ id: "cn", kind: StepKind.Notify, title: "deep" }],
			),
		});
		const callB: SubWorkflowStep = { id: "callB", kind: StepKind.SubWorkflow, workflowId: "B" };
		const result = await runWith(p, [callB]);
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
		expect(p.notify).toHaveBeenCalledTimes(1);
	});
});

describe("default condition evaluator", () => {
	const empty = new Map<string, unknown>();
	it("handles literals, input ref, and step-id refs", () => {
		expect(defaultConditionEvaluator("true", { input: null, outputs: empty })).toBe(true);
		expect(defaultConditionEvaluator("false", { input: 1, outputs: empty })).toBe(false);
		expect(defaultConditionEvaluator("input", { input: "x", outputs: empty })).toBe(true);
		expect(defaultConditionEvaluator("", { input: 0, outputs: empty })).toBe(false);
		expect(defaultConditionEvaluator("s1", { input: null, outputs: new Map([["s1", true]]) })).toBe(
			true,
		);
		expect(defaultConditionEvaluator("unknown", { input: 1, outputs: empty })).toBe(false);
	});

	it("evaluates the full sandboxed grammar (comparisons, members, built-ins)", () => {
		expect(
			defaultConditionEvaluator("input.count > 3", { input: { count: 5 }, outputs: empty }),
		).toBe(true);
		expect(
			defaultConditionEvaluator("input.count > 3", { input: { count: 1 }, outputs: empty }),
		).toBe(false);
		expect(
			defaultConditionEvaluator('input.status == "done"', {
				input: { status: "done" },
				outputs: empty,
			}),
		).toBe(true);
		expect(
			defaultConditionEvaluator("!input.active", { input: { active: false }, outputs: empty }),
		).toBe(true);
		expect(
			defaultConditionEvaluator("len(s1) > 0 && input", {
				input: true,
				outputs: new Map([["s1", [1, 2]]]),
			}),
		).toBe(true);
	});

	it("fails closed (false) on a parse error, unknown function, or blocked key", () => {
		expect(defaultConditionEvaluator("input.", { input: { a: 1 }, outputs: empty })).toBe(false);
		expect(defaultConditionEvaluator("danger()", { input: 1, outputs: empty })).toBe(false);
		expect(defaultConditionEvaluator("input.__proto__", { input: {}, outputs: empty })).toBe(false);
	});

	it("resolves a hyphenated step-id ref by whole-string lookup, not subtraction", () => {
		// `sub-n` would tokenize as `sub - n` under the grammar; the whole-string
		// outputs lookup must win so a hyphenated step id keeps working.
		const outputs = new Map<string, unknown>([["sub-n", true]]);
		expect(defaultConditionEvaluator("sub-n", { input: null, outputs })).toBe(true);
		expect(
			defaultConditionEvaluator("sub-n", { input: null, outputs: new Map([["sub-n", false]]) }),
		).toBe(false);
	});
});

describe("default collection resolver", () => {
	const empty = new Map<string, unknown>();
	it("resolves input + step-id refs to arrays, else empty", () => {
		expect(defaultCollectionResolver("input", { input: [1, 2], outputs: empty })).toEqual([1, 2]);
		expect(defaultCollectionResolver("", { input: [3], outputs: empty })).toEqual([3]);
		expect(defaultCollectionResolver("input", { input: "no", outputs: empty })).toEqual([]);
		expect(
			defaultCollectionResolver("s1", { input: null, outputs: new Map([["s1", ["a"]]]) }),
		).toEqual(["a"]);
	});

	it("resolves expressions to arrays (member access + built-ins), else empty", () => {
		expect(
			defaultCollectionResolver("input.items", { input: { items: [1, 2] }, outputs: empty }),
		).toEqual([1, 2]);
		expect(
			defaultCollectionResolver('split(input, ",")', { input: "a,b,c", outputs: empty }),
		).toEqual(["a", "b", "c"]);
		expect(defaultCollectionResolver("input.missing", { input: {}, outputs: empty })).toEqual([]);
		expect(defaultCollectionResolver("oops(", { input: [1], outputs: empty })).toEqual([]);
	});

	it("resolves a hyphenated step-id ref by whole-string lookup", () => {
		expect(
			defaultCollectionResolver("data-rows", {
				input: null,
				outputs: new Map([["data-rows", [1, 2]]]),
			}),
		).toEqual([1, 2]);
	});
});

describe("HTTP interpreter (11b.8)", () => {
	const httpStep = (url: string, method = "GET"): WorkflowStep =>
		({ id: "h", kind: StepKind.HTTP, method, url }) as WorkflowStep;

	it("is a gated kind when no http port is wired", async () => {
		const p = ports();
		const result = await runWith(p, [httpStep("https://api.example.com/x")]);
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("unsupported-step-kind");
	});

	it("GETs and outputs parsed JSON with the status", async () => {
		const http = vi.fn(async () => ({ status: 200, bodyText: '{"ok":true}' }));
		const result = await runWith(ports({ http }), [httpStep("https://api.example.com/x")]);
		expect(http).toHaveBeenCalledWith({ method: "GET", url: "https://api.example.com/x" });
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
		expect(result.stepLog[0]?.output).toEqual({ status: 200, body: { ok: true } });
	});

	it("POSTs the step input as a JSON body; non-JSON responses stay text", async () => {
		const http = vi.fn(async (_req: HttpStepRequest) => ({ status: 201, bodyText: "created" }));
		const result = await runWith(ports({ http }), [httpStep("https://api.example.com/x", "post")], {
			name: "from-trigger",
		});
		const call = http.mock.calls[0]?.[0] as HttpStepRequest;
		expect(call.method).toBe("POST");
		expect(new TextDecoder().decode(call.body)).toBe('{"name":"from-trigger"}');
		expect(result.stepLog[0]?.output).toEqual({ status: 201, body: "created" });
	});

	it("fails non-retriably on 4xx and retriably on 5xx", async () => {
		const notFound = vi.fn(async () => ({ status: 404, bodyText: "nope" }));
		const r404 = await runWith(ports({ http: notFound }), [httpStep("https://a.example/x")]);
		expect(r404.status).toBe(WorkflowRunStatus.Failed);
		expect(r404.error).toBe("http-status-404");
		expect(notFound).toHaveBeenCalledTimes(1);

		// A retriable 500 is re-attempted under the runner's retry policy.
		let calls = 0;
		const flaky = vi.fn(async () => {
			calls += 1;
			return calls === 1 ? { status: 500, bodyText: "err" } : { status: 200, bodyText: "{}" };
		});
		const runner = new WorkflowRunner(createCoreInterpreters(ports({ http: flaky })), {
			clock: () => 1,
			sleep: async () => {},
			retry: { maxAttempts: 2 },
		});
		const r = await runner.run({
			workflowId: "wf1",
			triggeredBy: "fire1",
			steps: [httpStep("https://a.example/x")],
		});
		expect(flaky).toHaveBeenCalledTimes(2);
		expect(r.status).toBe(WorkflowRunStatus.Succeeded);
	});

	it("rejects invalid urls and non-http protocols without touching the port", async () => {
		const http = vi.fn(async () => ({ status: 200, bodyText: "{}" }));
		const bad = await runWith(ports({ http }), [httpStep("not a url")]);
		expect(bad.error).toContain("http-invalid-url");
		const file = await runWith(ports({ http }), [httpStep("file:///etc/passwd")]);
		expect(file.error).toContain("http-unsupported-protocol");
		expect(http).not.toHaveBeenCalled();
	});
});

describe("Export interpreter (IE-8)", () => {
	const exportStep = (format: string): WorkflowStep =>
		({ id: "x", kind: StepKind.Export, format }) as WorkflowStep;

	it("is a gated kind when no exporter port is wired", async () => {
		const result = await runWith(ports(), [exportStep("json")], "note-1");
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("unsupported-step-kind");
	});

	it("serializes the operand ids and outputs the format, ids and content", async () => {
		const exporter = vi.fn(async () => '[{"id":"note-1"}]');
		const result = await runWith(ports({ exporter }), [exportStep("json")], "note-1");
		expect(exporter).toHaveBeenCalledWith({ format: "json", ids: ["note-1"] });
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
		expect(result.stepLog[0]?.output).toEqual({
			format: "json",
			ids: ["note-1"],
			content: '[{"id":"note-1"}]',
		});
	});

	it("collects ids from an array of entity records (a prior Query / ForEach output)", async () => {
		const exporter = vi.fn(async () => "a,b");
		const rows = [
			{ id: "e1", type: "T", properties: {} },
			{ id: "e2", type: "T", properties: {} },
		];
		const result = await runWith(ports({ exporter }), [exportStep("csv")], rows);
		expect(exporter).toHaveBeenCalledWith({ format: "csv", ids: ["e1", "e2"] });
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
	});

	it("fails non-retriably on an unknown format without touching the port", async () => {
		const exporter = vi.fn(async () => "");
		const result = await runWith(ports({ exporter }), [exportStep("pdf")], "note-1");
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("export-invalid-format");
		expect(exporter).not.toHaveBeenCalled();
	});

	it("fails when the operand carries no entity ids", async () => {
		const exporter = vi.fn(async () => "");
		const result = await runWith(ports({ exporter }), [exportStep("markdown")], { nope: 1 });
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("export-needs entity ids");
		expect(exporter).not.toHaveBeenCalled();
	});
});

describe("AICall interpreter (11b.7)", () => {
	const aiCallStep = (over: Record<string, unknown> = {}): WorkflowStep =>
		({ id: "a", kind: StepKind.AICall, instructions: "Summarise this.", ...over }) as WorkflowStep;

	it("is a gated kind when no ai port is wired", async () => {
		const result = await runWith(ports(), [aiCallStep()]);
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("unsupported-step-kind");
	});

	it("sends instructions as system + the prior output as the user turn", async () => {
		const ai = vi.fn<NonNullable<InterpreterPorts["ai"]>>(async () => ({
			content: "a summary",
			provenance: { provider: "ollama", model: "m", generatedAt: "t" },
		}));
		const result = await runWith(ports({ ai }), [aiCallStep({ provider: "ollama" })], "raw text");
		const req = ai.mock.calls[0]?.[0];
		expect(req?.provider).toBe("ollama");
		expect(req?.messages[0]).toEqual({ role: "system", content: "Summarise this." });
		expect(req?.messages[1]).toEqual({ role: "user", content: "raw text" });
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
		expect(result.stepLog[0]?.output).toMatchObject({ content: "a summary" });
	});

	it("JSON-encodes a structured prior output as the user turn", async () => {
		const ai = vi.fn<NonNullable<InterpreterPorts["ai"]>>(async () => ({ content: "ok" }));
		await runWith(ports({ ai }), [aiCallStep()], { title: "x", n: 2 });
		const req = ai.mock.calls[0]?.[0];
		expect(req?.messages[1]?.content).toBe('{"title":"x","n":2}');
	});

	it("a broker failure (unavailable provider) fails the step", async () => {
		const ai = vi.fn(async () => {
			throw new Error("no AI provider is configured");
		});
		const result = await runWith(ports({ ai }), [aiCallStep()]);
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("no AI provider");
	});
});

describe("AIAgent interpreter (11b.7 — shared loop, fail-closed tools)", () => {
	const agentStep = (over: Record<string, unknown> = {}): WorkflowStep =>
		({
			id: "g",
			kind: StepKind.AIAgent,
			instructions: "Do the task.",
			tools: [{ verb: "search", label: "Search" }],
			...over,
		}) as WorkflowStep;

	it("is a gated kind when no ai port is wired", async () => {
		const result = await runWith(ports(), [agentStep()]);
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("unsupported-step-kind");
	});

	it("dispatches an offered tool call through the intents port, then finishes", async () => {
		let n = 0;
		const ai = vi.fn(async () => {
			n += 1;
			return {
				content: n === 1 ? '{"tool":"search","args":{"q":"x"}}' : '{"final":"done"}',
			};
		});
		const intents = { dispatch: vi.fn(async () => ({ hits: 2 })) };
		const result = await runWith(
			ports({ ai, intents, capabilities: ["ai.use", "intents.dispatch:search"] }),
			[agentStep()],
		);
		expect(intents.dispatch).toHaveBeenCalledWith("search", undefined, { q: "x" });
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
		const output = result.stepLog[0]?.output as { finalAnswer: string };
		expect(output.finalAnswer).toBe("done");
	});

	it("never dispatches a tool the frozen caps do not cover (fail-closed)", async () => {
		const ai = vi.fn(async () => ({ content: '{"tool":"search","args":{}}' }));
		const intents = { dispatch: vi.fn(async () => null) };
		// The workflow holds ai.use but NOT intents.dispatch:search → tool dropped.
		const result = await runWith(ports({ ai, intents, capabilities: ["ai.use"] }), [
			agentStep({ maxIterations: 2 }),
		]);
		expect(intents.dispatch).not.toHaveBeenCalled();
		expect(result.status).toBe(WorkflowRunStatus.Succeeded);
	});

	it("passes the tool's declared entityType (not a model-supplied one) on dispatch", async () => {
		let n = 0;
		const ai = vi.fn(async () => {
			n += 1;
			return { content: n === 1 ? '{"tool":"create","args":{"x":1}}' : '{"final":"ok"}' };
		});
		const intents = { dispatch: vi.fn(async () => ({})) };
		await runWith(
			ports({
				ai,
				intents,
				capabilities: ["ai.use", "intents.dispatch:create", "entities.read:Note/v1"],
			}),
			[
				agentStep({
					tools: [{ verb: "create", entityType: "Note/v1", label: "Create" }],
				}),
			],
		);
		expect(intents.dispatch).toHaveBeenCalledWith("create", "Note/v1", { x: 1 });
	});

	it("a generate failure fails the step", async () => {
		const ai = vi.fn(async () => {
			throw new Error("provider down");
		});
		const result = await runWith(ports({ ai, capabilities: ["ai.use", "intents.dispatch:search"] }), [
			agentStep(),
		]);
		expect(result.status).toBe(WorkflowRunStatus.Failed);
		expect(result.error).toContain("provider down");
	});
});

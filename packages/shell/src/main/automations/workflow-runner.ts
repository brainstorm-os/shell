/**
 * `WorkflowRunner` (11b.3) — the shell-main interpreter that executes a
 * workflow's steps once a fire is handed over (doc 39 §Scheduler — where
 * triggers actually fire). It is shell-side, not renderer-side: a workflow
 * runs whether or not the automations window is open.
 *
 * This slice is the **runner core**: the step-interpreter *loop*, the
 * `WorkflowRun/v1` *provenance* (a flat, depth-tagged step log of every
 * step's input/output/duration/status), and the *failure / retry* policy.
 * The concrete per-kind interpreters (Intent / Entity / Notify / Wait /
 * Branch / ForEach / SubWorkflow) are injected — they land in 11b.4. By
 * keeping the clock, sleep, and every side effect behind injected ports the
 * whole fire → interpret → provenance → fail/retry path is exhaustively
 * unit-testable without real timers or a live vault.
 *
 * Faithful to doc 39 §Failure modes: a step that throws (or returns a
 * non-retriable failure, or exhausts its retries) fails the run; downstream
 * steps are recorded `skipped`; the run's `error` carries the message.
 * Runs are serialized per workflow by the scheduler/host (doc 39
 * §Scheduler) — the runner itself executes one workflow invocation.
 */

import {
	type StepId,
	StepKind,
	type WorkflowRunDef,
	WorkflowRunStatus,
	type WorkflowStep,
} from "@brainstorm-os/sdk-types";

/** Per-step execution result in the runner's provenance log. */
export enum StepRunStatus {
	Succeeded = "succeeded",
	Failed = "failed",
	/** Not reached — an earlier step failed or the run was aborted. */
	Skipped = "skipped",
}

/**
 * What an interpreter returns. A failure may be `retriable` (a transient
 * fault worth re-attempting under the `RetryPolicy`); the default is
 * non-retriable so a buggy interpreter can't spin.
 */
export type StepOutcome =
	| { ok: true; output: unknown }
	| { ok: false; error: string; retriable?: boolean };

/** One row of the run's provenance timeline (`WorkflowRun/v1.stepLog`). */
export type StepLogEntry = {
	stepId: StepId;
	kind: StepKind;
	status: StepRunStatus;
	/** Nesting level — 0 at the top, +1 inside a Branch/ForEach body — so
	 *  the Runs view (11b.13) can render the timeline as nested blocks. */
	depth: number;
	startedAt: number;
	durationMs: number;
	/** How many times the interpreter ran (1 unless retried). */
	attempts: number;
	output?: unknown;
	error?: string;
};

/**
 * The result of driving a (possibly nested) step sequence — returned to a
 * container interpreter from `RunContext.runChildren`. The entries are
 * already appended to the run's flat `stepLog` in chronological order;
 * `lastOutput` is the output of the final successful step (handy for a
 * ForEach interpreter accumulating per-iteration results).
 */
export type ChildRunResult = { status: WorkflowRunStatus; lastOutput: unknown };

/**
 * What an interpreter sees: the prior step's output as `input` (linear
 * data-flow — doc 39 §The step model "reference outputs of prior steps"),
 * the full prior-output map keyed by step id, the firing context, an
 * optional abort signal, and `runChildren` — so a container interpreter
 * (Branch/ForEach) drives its body through the same runner machinery and
 * inherits provenance + retry for free.
 */
export type RunContext = {
	workflowId: string;
	/** The fire id / trigger entity that caused this run (provenance). */
	triggeredBy: string;
	signal?: AbortSignal;
	/** The immediately-preceding step's output (the trigger payload for the
	 *  first step). The step's primary operand in the linear pipeline. */
	input: unknown;
	/** Prior step outputs by step id. Live (a later step sees an earlier
	 *  step's output) but presented read-only to interpreters. */
	outputs: ReadonlyMap<StepId, unknown>;
	/** The effective capability ceiling for THIS subtree (11b.6 gate 1). The
	 *  SubWorkflow interpreter narrows it to a callee's own declared caps when
	 *  it runs the callee's children, so a nested A→B→C re-scopes C against B's
	 *  caps — not A's. Undefined at the top: the interpreter falls back to its
	 *  ports' running caps there. */
	capabilities?: readonly string[];
	/** Drive a child step list. Omit `seed` to inherit the container step's
	 *  own `input` (Branch / SubWorkflow); pass `{ input }` to seed the first
	 *  child explicitly (a ForEach interpreter passes the current item). The
	 *  wrapper — not the value — signals seeding, so an item of `undefined`
	 *  seeds `undefined` rather than falling back to the container input.
	 *  `opts.capabilities` narrows the ceiling for the children (SubWorkflow). */
	runChildren(
		steps: readonly WorkflowStep[],
		seed?: { input: unknown },
		opts?: { capabilities: readonly string[] },
	): Promise<ChildRunResult>;
};

export type StepInterpreter = (step: WorkflowStep, ctx: RunContext) => Promise<StepOutcome>;

/** Kind → interpreter. A kind with no interpreter (a declared-but-gated
 *  one, e.g. AICall before Stage 11) fails its step cleanly rather than
 *  throwing — the run records `unsupported-step-kind:<kind>`. */
export type InterpreterRegistry = Partial<Record<StepKind, StepInterpreter>>;

/** Bounded re-attempt policy for `retriable` failures. `maxAttempts: 1`
 *  (the default) means no retry. `backoffMs` is the delay before attempt
 *  N+1 (slept via the injected `sleep`); absent = no delay. */
export type RetryPolicy = { maxAttempts: number; backoffMs?: (attempt: number) => number };

export type WorkflowRunnerOptions = {
	/** Provenance timestamps. Injected so tests are deterministic. */
	clock?: () => number;
	/** Backoff sleeper. Injected so tests don't wait on real timers. */
	sleep?: (ms: number) => Promise<void>;
	retry?: RetryPolicy;
};

export type WorkflowRunInput = {
	workflowId: string;
	steps: readonly WorkflowStep[];
	triggeredBy: string;
	/** The trigger's payload, exposed as the leading Trigger step's output. */
	triggerPayload?: unknown;
	/** Abort to cancel mid-run. `signal.reason === "timeout"` maps the run
	 *  to `timed-out`; any other abort maps to `cancelled`. */
	signal?: AbortSignal;
};

export type WorkflowRunResult = {
	workflowId: string;
	triggeredBy: string;
	status: WorkflowRunStatus;
	stepLog: StepLogEntry[];
	error?: string;
	startedAt: number;
	finishedAt: number;
};

/** The abort reason a host passes to map a cancellation to `timed-out`
 *  rather than `cancelled` (doc 39 — a run that overruns its budget). */
export const TIMEOUT_ABORT_REASON = "timeout";

const NO_RETRY: RetryPolicy = { maxAttempts: 1 };
const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

function abortStatus(signal: AbortSignal | undefined): WorkflowRunStatus {
	return signal?.reason === TIMEOUT_ABORT_REASON
		? WorkflowRunStatus.TimedOut
		: WorkflowRunStatus.Cancelled;
}

export class WorkflowRunner {
	private readonly clock: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly retry: RetryPolicy;

	constructor(
		private readonly interpreters: InterpreterRegistry,
		opts: WorkflowRunnerOptions = {},
	) {
		this.clock = opts.clock ?? Date.now;
		this.sleep = opts.sleep ?? defaultSleep;
		this.retry = opts.retry ?? NO_RETRY;
	}

	/** Execute one workflow invocation, producing its provenance + status. */
	async run(input: WorkflowRunInput): Promise<WorkflowRunResult> {
		const startedAt = this.clock();
		const outputs = new Map<StepId, unknown>();
		const stepLog: StepLogEntry[] = [];

		// Seed the leading Trigger pseudo-step's output with the fire payload
		// so downstream steps can reference it (doc 39 §The step model).
		const trigger = input.steps.find((s) => s.kind === StepKind.Trigger);
		if (trigger) outputs.set(trigger.id, input.triggerPayload);

		const { status } = await this.executeSequence(input.steps, {
			outputs,
			stepLog,
			depth: 0,
			seedInput: input.triggerPayload,
			workflowId: input.workflowId,
			triggeredBy: input.triggeredBy,
			...(input.signal ? { signal: input.signal } : {}),
		});

		const failure = stepLog.find((e) => e.status === StepRunStatus.Failed);
		return {
			workflowId: input.workflowId,
			triggeredBy: input.triggeredBy,
			status,
			stepLog,
			startedAt,
			finishedAt: this.clock(),
			...(failure?.error ? { error: failure.error } : {}),
		};
	}

	private async executeSequence(
		steps: readonly WorkflowStep[],
		frame: SequenceFrame,
	): Promise<{ status: WorkflowRunStatus; lastOutput: unknown }> {
		let input = frame.seedInput;
		let lastOutput: unknown;
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			if (!step) continue;

			if (frame.signal?.aborted) {
				this.skipRemaining(steps.slice(i), frame);
				return { status: abortStatus(frame.signal), lastOutput };
			}

			const { entry, outcome } = await this.runStep(step, frame, input);
			frame.stepLog.push(entry);

			if (outcome.ok) {
				frame.outputs.set(step.id, outcome.output);
				input = outcome.output;
				lastOutput = outcome.output;
				continue;
			}

			// A failure (or abort surfaced as one) halts the sequence: record
			// the rest as skipped and propagate the terminal status up.
			this.skipRemaining(steps.slice(i + 1), frame);
			const status = frame.signal?.aborted ? abortStatus(frame.signal) : WorkflowRunStatus.Failed;
			return { status, lastOutput };
		}
		return { status: WorkflowRunStatus.Succeeded, lastOutput };
	}

	private async runStep(
		step: WorkflowStep,
		frame: SequenceFrame,
		input: unknown,
	): Promise<{ entry: StepLogEntry; outcome: StepOutcome }> {
		const startedAt = this.clock();
		const ctx: RunContext = {
			input,
			outputs: frame.outputs,
			workflowId: frame.workflowId,
			triggeredBy: frame.triggeredBy,
			...(frame.signal ? { signal: frame.signal } : {}),
			...(frame.capabilities !== undefined ? { capabilities: frame.capabilities } : {}),
			runChildren: (children, seed, opts) =>
				this.executeSequence(children, {
					...frame,
					depth: frame.depth + 1,
					seedInput: seed ? seed.input : input,
					// A SubWorkflow narrows the ceiling to the callee's caps; Branch /
					// ForEach pass nothing and inherit this frame's ceiling.
					...(opts?.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
				}),
		};

		let attempts = 0;
		let outcome = await this.invoke(step, ctx);
		attempts++;
		while (
			!outcome.ok &&
			outcome.retriable === true &&
			attempts < this.retry.maxAttempts &&
			!frame.signal?.aborted
		) {
			const delay = this.retry.backoffMs?.(attempts) ?? 0;
			if (delay > 0) await this.sleep(delay);
			if (frame.signal?.aborted) break;
			outcome = await this.invoke(step, ctx);
			attempts++;
		}

		const entry: StepLogEntry = {
			stepId: step.id,
			kind: step.kind,
			status: outcome.ok ? StepRunStatus.Succeeded : StepRunStatus.Failed,
			depth: frame.depth,
			startedAt,
			durationMs: this.clock() - startedAt,
			attempts,
			...(outcome.ok ? { output: outcome.output } : { error: outcome.error }),
		};
		return { entry, outcome };
	}

	/** Run a single step's interpreter once, never throwing — a thrown error
	 *  becomes a non-retriable failure so one bad interpreter can't crash the
	 *  run loop. The Trigger pseudo-step needs no interpreter. */
	private async invoke(step: WorkflowStep, ctx: RunContext): Promise<StepOutcome> {
		if (step.kind === StepKind.Trigger) {
			return { ok: true, output: ctx.outputs.get(step.id) };
		}
		const interpreter = this.interpreters[step.kind];
		if (!interpreter) {
			return { ok: false, error: `unsupported-step-kind:${step.kind}`, retriable: false };
		}
		try {
			return await interpreter(step, ctx);
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e), retriable: false };
		}
	}

	private skipRemaining(steps: readonly WorkflowStep[], frame: SequenceFrame): void {
		const at = this.clock();
		for (const step of steps) {
			if (!step) continue;
			frame.stepLog.push({
				stepId: step.id,
				kind: step.kind,
				status: StepRunStatus.Skipped,
				depth: frame.depth,
				startedAt: at,
				durationMs: 0,
				attempts: 0,
			});
		}
	}
}

type SequenceFrame = {
	outputs: Map<StepId, unknown>;
	stepLog: StepLogEntry[];
	depth: number;
	/** The `input` for the sequence's first step (trigger payload at the top,
	 *  the current item for a ForEach body, the container's input otherwise). */
	seedInput: unknown;
	signal?: AbortSignal;
	workflowId: string;
	triggeredBy: string;
	/** Effective capability ceiling for this sequence (11b.6 gate 1); narrowed
	 *  by a SubWorkflow when it runs a callee's body. Undefined at the top. */
	capabilities?: readonly string[];
};

/**
 * Map a finished run into the `brainstorm/WorkflowRun/v1` entity the host
 * persists for provenance (doc 39 §`brainstorm/WorkflowRun/v1`). The
 * structured `stepLog` is carried as-is (the Runs view renders the
 * timeline); `triggeredAt` is the run's start as an ISO instant.
 */
export function toWorkflowRunDef(result: WorkflowRunResult): WorkflowRunDef {
	const def: WorkflowRunDef = {
		workflow: result.workflowId,
		triggeredBy: result.triggeredBy,
		triggeredAt: new Date(result.startedAt).toISOString(),
		status: result.status,
		stepLog: result.stepLog,
	};
	return result.error ? { ...def, error: result.error } : def;
}

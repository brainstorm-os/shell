/**
 * The core-set `StepKind` interpreters (11b.4) — the concrete behaviour the
 * 11b.3 `WorkflowRunner` loop drives. Each is a `StepInterpreter` injected
 * into the runner's `InterpreterRegistry`; the runner owns provenance,
 * failure, and retry, so an interpreter just *does the one thing* and
 * returns a `StepOutcome`.
 *
 * Faithful to doc 39 §The step model: side effects go through **injected
 * ports** (intents bus, entities service, notifications, sleep), never a
 * direct broker import — so every interpreter is unit-testable with fakes
 * and the live broker wiring lives in one adapter (`broker-interpreter-ports`).
 *
 * Data flows linearly: a step's operand is `ctx.input` (the prior step's
 * output; the trigger payload for the first step). The rich per-field
 * binding model (Yjs `RelativePosition` anchors) is the builder's concern —
 * OQ-166, gated with 11b.11 — so the engine spine uses the simple
 * prior-output convention, which the builder will later refine without
 * changing this runtime contract.
 *
 * Scope: Trigger is a runner no-op (no interpreter). `Code` (11b.9 /
 * OQ-167 → (a)) joins the set via the sandboxed-expression evaluator;
 * `HTTP` (11b.8) joins over the Net-1 egress port, registered only when
 * the host wires it; `AICall`/`AIAgent` (Stage 11) remain out.
 */

import {
	type AIAgentStep,
	type AICallStep,
	AgentStopReason,
	type AgentToolCall,
	type AiChatMessage,
	type AiProvenance,
	type BranchStep,
	type CodeStep,
	EXPORT_TEXT_FORMATS,
	EntityOp,
	type EntityStep,
	type ExportStep,
	type ExportTextFormat,
	type ForEachStep,
	type HTTPStep,
	type IntentStep,
	MessageRole,
	type NotifyStep,
	type StepId,
	StepKind,
	type SubWorkflowStep,
	type WaitStep,
	WorkflowRunStatus,
	type WorkflowStep,
	aggregateWorkflowCapabilities,
	missingCapabilities,
	runAgentLoop,
} from "@brainstorm-os/sdk-types";
import { type ExprScope, ExpressionError, evaluateExpression } from "./code-expression";
import type {
	ChildRunResult,
	InterpreterRegistry,
	RunContext,
	StepInterpreter,
	StepOutcome,
} from "./workflow-runner";

// ─────────────────────────────── ports ───────────────────────────────

/** A created/updated/fetched entity, opaque to the runner. */
export type EntityRecord = { id: string; type: string; properties: Record<string, unknown> };

/** The entities host service, narrowed to what the Entity step needs. */
export type EntitiesPort = {
	create(type: string, properties: Record<string, unknown>): Promise<EntityRecord>;
	update(id: string, patch: Record<string, unknown>): Promise<EntityRecord>;
	get(id: string): Promise<EntityRecord | null>;
	query(type: string, filter?: Record<string, unknown>): Promise<EntityRecord[]>;
	delete(id: string): Promise<void>;
};

/** The intents bus, narrowed to a single dispatch. */
export type IntentsPort = {
	dispatch(
		verb: string,
		entityType: string | undefined,
		args: Record<string, unknown> | undefined,
	): Promise<unknown>;
};

/** The notifications host service. */
export type NotifyPort = (n: {
	title: string;
	body?: string;
	target?: string;
}) => Promise<void> | void;

/** A referenced sub-workflow resolved for execution: its steps plus its OWN
 *  frozen `capabilities[]` (the consent surface the user approved for it),
 *  needed so the call boundary can re-scope it (11b.6 security gate 1) rather
 *  than letting it run under the caller's broader caps. */
export type LoadedSubWorkflow = {
	steps: readonly WorkflowStep[];
	capabilities: readonly string[];
};

/**
 * A loader for `SubWorkflow` steps — returns the referenced workflow's steps +
 * its own frozen caps (read from the entities service by the adapter), or
 * `null` when the workflow is missing / disabled.
 */
export type WorkflowStepsLoader = (workflowId: string) => Promise<LoadedSubWorkflow | null>;

/**
 * Branch condition evaluator. The default (`defaultConditionEvaluator`) runs
 * the same sandboxed expression grammar as the `Code` step (OQ-167 / 11b.9);
 * the port stays overridable so a host can substitute a different evaluator
 * without touching the Branch interpreter.
 */
export type ConditionEvaluator = (
	expression: string,
	ctx: { input: unknown; outputs: ReadonlyMap<StepId, unknown> },
) => boolean;

/**
 * ForEach collection resolver — turns the step's `collection` reference into
 * the array to iterate, through the same expression grammar as the condition
 * evaluator. Overridable for the same reason.
 */
export type CollectionResolver = (
	reference: string,
	ctx: { input: unknown; outputs: ReadonlyMap<StepId, unknown> },
) => unknown[];

/**
 * The HTTP egress port (11b.8). Backed in production by Net-1's
 * `executeNetworkFetch` via the broker adapter — which ALSO enforces the
 * workflow's frozen `network.egress:<origin>` capability before any bytes
 * leave (fail-closed; the host's three-tier gate is the outer check).
 * Absent port = the HTTP step kind stays gated (`unsupported-step-kind`).
 */
export type HttpStepRequest = {
	method: string;
	url: string;
	/** JSON body bytes for non-GET/HEAD methods carrying the step input. */
	body?: Uint8Array;
};

export type HttpStepResponse = {
	status: number;
	bodyText: string;
};

export type HttpPort = (req: HttpStepRequest) => Promise<HttpStepResponse>;

/**
 * The export port (IE-8). Backed in production by the `export` host service's
 * `serializeEntities` handler — which gates each entity on the workflow's
 * frozen `entities.read:<type>` capability (the ledger is the enforcer), so an
 * Export step can only serialize entity types the workflow already reads.
 * Absent port = the Export step kind stays gated (`unsupported-step-kind`).
 */
export type ExportStepRequest = { format: ExportTextFormat; ids: readonly string[] };
export type ExportPort = (req: ExportStepRequest) => Promise<string>;

/**
 * The AI port (11b.7). Backed in production by the broker `ai` service's
 * `generate` verb under the workflow's frozen caps (`ai.use` +
 * `ai.provider:<id>` are enforced by the ledger on the carrier envelope, so an
 * AI step can only run a provider the workflow declared). Absent port = the
 * `AICall`/`AIAgent` step kinds stay gated (`unsupported-step-kind`).
 *
 * It is a single-purpose `generate` seam (a transcript → a completion + its
 * provenance) — the same surface the Agent app drives. The `AICall` interpreter
 * uses it directly; the `AIAgent` interpreter drives the shared
 * `runAgentLoop` over it plus an intent dispatcher (the loop's `dispatchTool`).
 */
export type AiGeneratePort = (req: {
	messages: readonly AiChatMessage[];
	provider?: string;
	model?: string;
}) => Promise<{ content: string; provenance?: AiProvenance }>;

export type InterpreterPorts = {
	intents: IntentsPort;
	entities: EntitiesPort;
	notify: NotifyPort;
	sleep: (ms: number) => Promise<void>;
	loadWorkflowSteps: WorkflowStepsLoader;
	/** The frozen capability set these ports were built under (the running
	 *  workflow's caps). The SubWorkflow interpreter re-scopes a callee against
	 *  this ceiling (11b.6 security gate 1); the AIAgent interpreter passes it as
	 *  the loop's fail-closed `frozenCapabilities` ceiling. */
	capabilities: readonly string[];
	evaluateCondition?: ConditionEvaluator;
	resolveCollection?: CollectionResolver;
	/** 11b.8 — optional: present only when the host wires real egress. */
	http?: HttpPort;
	/** IE-8 — optional: present only when the host wires the export service. */
	exporter?: ExportPort;
	/** 11b.7 — optional: present only when the host wires the AI broker. */
	ai?: AiGeneratePort;
};

// ─────────────────────── condition / collection eval ───────────────────────

/** Grammar literals / the canonical scope var — these keep their native
 *  meaning and are never short-circuited to a same-named step-output, so a
 *  step id like "true" can't shadow the boolean literal. */
const RESERVED_REFS = new Set(["true", "false", "null", "input"]);

/** Evaluate a Branch condition through the same sandboxed expression grammar
 *  as the `Code` step (OQ-167 → (a); `code-expression.ts`), over a scope of
 *  the prior-step outputs plus the canonical `input`. An empty condition is
 *  the truthiness of `input`; a parse / evaluation error — including an
 *  unknown identifier, which resolves to `undefined` — is conservatively
 *  `false`, so Branch fails closed to its `alternate`. A condition that is
 *  EXACTLY a prior step id is resolved by a whole-string lookup before the
 *  grammar runs, so a hyphenated id (`"step-1"`) keeps working rather than
 *  parsing as subtraction; `true` / `false` / `input` parse natively. */
export const defaultConditionEvaluator: ConditionEvaluator = (expression, ctx) => {
	const expr = expression.trim();
	if (expr === "") return Boolean(ctx.input);
	if (!RESERVED_REFS.has(expr) && ctx.outputs.has(expr)) return Boolean(ctx.outputs.get(expr));
	try {
		return Boolean(evaluateExpression(expr, expressionScope(ctx)));
	} catch {
		return false;
	}
};

/** Resolve a ForEach collection through the same grammar. An empty reference
 *  is the prior `input`; a reference that is EXACTLY a prior step id resolves
 *  by whole-string lookup (so a hyphenated id survives); any other expression
 *  evaluating to a non-array (or a parse error) yields `[]` rather than
 *  throwing, so a misconfigured loop stays inert instead of fatal. */
export const defaultCollectionResolver: CollectionResolver = (reference, ctx) => {
	const ref = reference.trim();
	if (ref === "") return Array.isArray(ctx.input) ? ctx.input : [];
	if (!RESERVED_REFS.has(ref) && ctx.outputs.has(ref)) {
		const value = ctx.outputs.get(ref);
		return Array.isArray(value) ? value : [];
	}
	try {
		const value = evaluateExpression(ref, expressionScope(ctx));
		return Array.isArray(value) ? value : [];
	} catch {
		return [];
	}
};

// ───────────────────────── operand coercion ─────────────────────────

/** Pull an entity id out of an operand: a bare string, or `{ id }`. */
function operandId(input: unknown): string | null {
	if (typeof input === "string" && input.length > 0) return input;
	if (input && typeof input === "object" && typeof (input as { id?: unknown }).id === "string") {
		return (input as { id: string }).id;
	}
	return null;
}

/** Pull a list of entity ids out of an operand: a single id/`{id}`, or an
 *  array of those (e.g. a prior Query / ForEach output of entity records). */
function operandIds(input: unknown): string[] {
	const items = Array.isArray(input) ? input : [input];
	const ids: string[] = [];
	for (const item of items) {
		const id = operandId(item);
		if (id) ids.push(id);
	}
	return ids;
}

/** Pull a plain properties object out of an operand (for create/update). */
function operandProperties(input: unknown): Record<string, unknown> {
	if (input && typeof input === "object" && !Array.isArray(input)) {
		// `{ id, patch }` / `{ id, properties }` envelopes hand back their inner
		// object; a raw map is used as-is.
		const obj = input as Record<string, unknown>;
		if (obj.patch && typeof obj.patch === "object") return obj.patch as Record<string, unknown>;
		if (obj.properties && typeof obj.properties === "object") {
			return obj.properties as Record<string, unknown>;
		}
		return obj;
	}
	return {};
}

// ─────────────────────────── interpreters ───────────────────────────

const intentInterpreter =
	(ports: InterpreterPorts): StepInterpreter =>
	async (step) => {
		const s = step as IntentStep;
		const output = await ports.intents.dispatch(s.verb, s.entityType, s.args);
		return { ok: true, output };
	};

const entityInterpreter =
	(ports: InterpreterPorts): StepInterpreter =>
	async (step, ctx) => {
		const s = step as EntityStep;
		switch (s.op) {
			case EntityOp.Create:
				return {
					ok: true,
					output: await ports.entities.create(s.entityType, operandProperties(ctx.input)),
				};
			case EntityOp.Update: {
				const id = operandId(ctx.input);
				if (!id) return failOperand("update", "an entity id");
				const existing = await ports.entities.get(id);
				if (!existing) return notFound("update", id);
				if (existing.type !== s.entityType) return outOfScope("update", existing.type, s.entityType);
				return { ok: true, output: await ports.entities.update(id, operandProperties(ctx.input)) };
			}
			case EntityOp.Get: {
				const id = operandId(ctx.input);
				if (!id) return failOperand("get", "an entity id");
				const entity = await ports.entities.get(id);
				// A missing entity stays a `null` read (no scope question to fail);
				// a present one must be within the step's declared type scope.
				if (entity && entity.type !== s.entityType) {
					return outOfScope("get", entity.type, s.entityType);
				}
				return { ok: true, output: entity };
			}
			case EntityOp.Delete: {
				const id = operandId(ctx.input);
				if (!id) return failOperand("delete", "an entity id");
				const existing = await ports.entities.get(id);
				if (!existing) return notFound("delete", id);
				if (existing.type !== s.entityType) return outOfScope("delete", existing.type, s.entityType);
				await ports.entities.delete(id);
				return { ok: true, output: { id, deleted: true } };
			}
			case EntityOp.Query: {
				const filter =
					ctx.input && typeof ctx.input === "object" && !Array.isArray(ctx.input)
						? (ctx.input as Record<string, unknown>)
						: undefined;
				return { ok: true, output: await ports.entities.query(s.entityType, filter) };
			}
			default:
				return { ok: false, error: `unsupported-entity-op:${String(s.op)}`, retriable: false };
		}
	};

function failOperand(op: string, needs: string): StepOutcome {
	return { ok: false, error: `entity-${op}-needs ${needs}`, retriable: false };
}

/** 11b.6 security gate — runtime entity-type scope. The operand id comes from
 *  the untrusted trigger payload and the entities service authorizes by the
 *  FETCHED entity's type, so an `Entity` step declared on one type could
 *  otherwise reach across to an entity of any other type the app can touch.
 *  Refusing a type mismatch (and an unverifiable missing target for the
 *  mutating ops) keeps a step inside its declared `entityType`. Non-retriable
 *  — re-running won't change the target's type. */
function outOfScope(op: string, actual: string, declared: string): StepOutcome {
	return { ok: false, error: `entity-${op}-out-of-scope:${actual}!=${declared}`, retriable: false };
}

function notFound(op: string, id: string): StepOutcome {
	return { ok: false, error: `entity-${op}-not-found:${id}`, retriable: false };
}

const notifyInterpreter =
	(ports: InterpreterPorts): StepInterpreter =>
	async (step) => {
		const s = step as NotifyStep;
		await ports.notify({
			title: s.title,
			...(s.body !== undefined ? { body: s.body } : {}),
			...(s.target !== undefined ? { target: s.target } : {}),
		});
		return { ok: true, output: null };
	};

const waitInterpreter =
	(ports: InterpreterPorts): StepInterpreter =>
	async (step, ctx) => {
		const s = step as WaitStep;
		// `untilCondition` is parked (doc 39 §Wait); the engine honours
		// `durationMs`. A wait passes its input through unchanged so the
		// pipeline's data keeps flowing.
		if (typeof s.durationMs === "number" && s.durationMs > 0) await ports.sleep(s.durationMs);
		return { ok: true, output: ctx.input };
	};

const branchInterpreter =
	(ports: InterpreterPorts): StepInterpreter =>
	async (step, ctx) => {
		const s = step as BranchStep;
		const evaluate = ports.evaluateCondition ?? defaultConditionEvaluator;
		const taken = evaluate(s.condition, { input: ctx.input, outputs: ctx.outputs })
			? s.consequent
			: s.alternate;
		if (!taken || taken.length === 0) return { ok: true, output: ctx.input };
		const child = await ctx.runChildren(taken);
		return childOutcome(child, ctx.input);
	};

const forEachInterpreter =
	(ports: InterpreterPorts): StepInterpreter =>
	async (step, ctx) => {
		const s = step as ForEachStep;
		const resolve = ports.resolveCollection ?? defaultCollectionResolver;
		const items = resolve(s.collection, { input: ctx.input, outputs: ctx.outputs });
		const results: unknown[] = [];
		for (const item of items) {
			const child = await ctx.runChildren(s.body, { input: item });
			if (child.status !== WorkflowRunStatus.Succeeded) {
				return { ok: false, error: "for-each-body-failed", retriable: false };
			}
			results.push(child.lastOutput);
		}
		return { ok: true, output: results };
	};

const subWorkflowInterpreter =
	(ports: InterpreterPorts): StepInterpreter =>
	async (step, ctx) => {
		const s = step as SubWorkflowStep;
		const loaded = await ports.loadWorkflowSteps(s.workflowId);
		if (!loaded)
			return { ok: false, error: `sub-workflow-not-found:${s.workflowId}`, retriable: false };
		// 11b.6 security gate 1 — re-scope at the call boundary. A sub-workflow
		// runs under the CALLER's ports (its caps), and the caller's static
		// capability check never saw the callee's steps. Enforce the same
		// two-tier model as AutomationsHost.capabilityViolations: the callee's
		// steps must stay within its OWN declared caps, and its declared caps
		// within the ceiling in effect. The ceiling is the per-subtree ceiling
		// (ctx.capabilities) so a nested A→B→C re-scopes C against B's caps;
		// at the top it falls back to the ports' running caps.
		const ceiling = ctx.capabilities ?? ports.capabilities;
		const denied = [
			...missingCapabilities(aggregateWorkflowCapabilities(loaded.steps), loaded.capabilities),
			...missingCapabilities(loaded.capabilities, ceiling),
		];
		if (denied.length > 0) {
			const detail = [...new Set(denied)].sort().join(",");
			return { ok: false, error: `sub-workflow-capability-denied:${detail}`, retriable: false };
		}
		// Seeds the sub-workflow with the parent's current input (inherited), and
		// narrows the ceiling to the callee's OWN caps for its body — so a nested
		// SubWorkflow is re-scoped against this callee, not the outermost caller.
		const child = await ctx.runChildren(loaded.steps, undefined, {
			capabilities: loaded.capabilities,
		});
		return childOutcome(child, child.lastOutput);
	};

/** Map a `runChildren` result into the container step's own outcome. */
function childOutcome(child: ChildRunResult, successOutput: unknown): StepOutcome {
	return child.status === WorkflowRunStatus.Succeeded
		? { ok: true, output: successOutput }
		: { ok: false, error: `nested-sequence-${child.status}`, retriable: false };
}

/** The expression scope shared by the `Code` step and the Branch/ForEach
 *  evaluators: the prior-step outputs by id, plus the canonical `input` (the
 *  immediately-prior output) — `input` always wins so a step literally named
 *  "input" can't shadow it. */
function expressionScope(ctx: {
	input: unknown;
	outputs: ReadonlyMap<StepId, unknown>;
}): ExprScope {
	return { ...Object.fromEntries(ctx.outputs), input: ctx.input };
}

export function codeExpressionScope(ctx: RunContext): ExprScope {
	return expressionScope(ctx);
}

/** `Code` step (11b.9, OQ-167 → (a)): evaluate the sandboxed expression
 *  against the workflow's prior outputs and emit its value. No ports — it
 *  is pure computation with no side effects (the whole point of the step:
 *  reshape data between effectful steps). A parse / type error fails the
 *  step non-retriably (re-running the same expression won't help). */
const codeInterpreter =
	(): StepInterpreter =>
	async (step, ctx): Promise<StepOutcome> => {
		const s = step as CodeStep;
		try {
			return { ok: true, output: evaluateExpression(s.expression, codeExpressionScope(ctx)) };
		} catch (err) {
			const message = err instanceof ExpressionError ? err.message : "expression-failed";
			return { ok: false, error: message, retriable: false };
		}
	};

const BODYLESS_METHODS = new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);
/** Transient statuses worth a retry under the step's `RetryPolicy`. */
const RETRIABLE_HTTP_STATUSES = new Set([408, 425, 429]);

const httpInterpreter =
	(http: HttpPort): StepInterpreter =>
	async (step, ctx) => {
		const s = step as HTTPStep;
		let url: URL;
		try {
			url = new URL(s.url);
		} catch {
			return { ok: false, error: `http-invalid-url:${s.url}`, retriable: false };
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			return { ok: false, error: `http-unsupported-protocol:${url.protocol}`, retriable: false };
		}
		const method = (s.method || "GET").toUpperCase();
		const request: HttpStepRequest = { method, url: s.url };
		// Linear data-flow: a body-carrying method posts the step input as JSON.
		if (!BODYLESS_METHODS.has(method) && ctx.input !== undefined && ctx.input !== null) {
			request.body = new TextEncoder().encode(JSON.stringify(ctx.input));
		}
		const response = await http(request);
		let body: unknown = response.bodyText;
		try {
			body = JSON.parse(response.bodyText);
		} catch {
			// Non-JSON response stays text.
		}
		if (response.status < 200 || response.status >= 300) {
			return {
				ok: false,
				error: `http-status-${response.status}`,
				retriable: response.status >= 500 || RETRIABLE_HTTP_STATUSES.has(response.status),
			};
		}
		return { ok: true, output: { status: response.status, body } };
	};

const EXPORT_FORMATS = new Set<string>(EXPORT_TEXT_FORMATS);

const exportInterpreter =
	(exporter: ExportPort): StepInterpreter =>
	async (step, ctx) => {
		const s = step as ExportStep;
		const format = (s.format ?? "").toLowerCase();
		if (!EXPORT_FORMATS.has(format)) {
			return { ok: false, error: `export-invalid-format:${String(s.format)}`, retriable: false };
		}
		const ids = operandIds(ctx.input);
		if (ids.length === 0) {
			return { ok: false, error: "export-needs entity ids", retriable: false };
		}
		const content = await exporter({ format: format as ExportTextFormat, ids });
		return { ok: true, output: { format, ids, content } };
	};

/** Render the prior-step operand as the AI step's `user` turn. A string flows
 *  in verbatim; anything else is JSON-encoded so structured prior output (a
 *  Query result, an entity record) is legible to the model. `undefined`/`null`
 *  (the leading step, an empty pipeline) contributes no operand turn. */
function operandTurn(input: unknown): AiChatMessage | null {
	if (input === undefined || input === null) return null;
	const content = typeof input === "string" ? input : JSON.stringify(input);
	if (content.length === 0) return null;
	return { role: MessageRole.User, content };
}

/** `AICall` step (11b.7) — a single-shot generation. The step's `instructions`
 *  are the `system` region; the prior-step output (if any) is the `user` turn,
 *  so an AICall reshapes/annotates the pipeline's data through the model. The
 *  provider/model are passed verbatim; the broker enforces `ai.provider:<id>`
 *  against the workflow's frozen caps on the carrier envelope (fail-closed). */
const aiCallInterpreter =
	(ai: AiGeneratePort): StepInterpreter =>
	async (step, ctx) => {
		const s = step as AICallStep;
		const messages: AiChatMessage[] = [{ role: MessageRole.System, content: s.instructions }];
		const operand = operandTurn(ctx.input);
		if (operand) messages.push(operand);
		const result = await ai({
			messages,
			...(s.provider ? { provider: s.provider } : {}),
			...(s.model ? { model: s.model } : {}),
		});
		return {
			ok: true,
			output: {
				content: result.content,
				...(result.provenance ? { provenance: result.provenance } : {}),
			},
		};
	};

/** `AIAgent` step (11b.7) — the shared tool-calling agent loop. The model is
 *  given the step's tools, intersected fail-closed against the workflow's
 *  FROZEN capability set (`runAgentLoop` drops any tool the caps don't cover and
 *  refuses an off-list/uncovered call mid-loop). A tool call dispatches the
 *  intent through the SAME capability-checked intents port the Intent step uses,
 *  so the ledger re-enforces `intents.dispatch:<verb>` server-side too. The
 *  loop is bounded by the step's `maxIterations` (hard-clamped by the loop). The
 *  full loop transcript is returned as the step output for run provenance. */
const aiAgentInterpreter =
	(ai: AiGeneratePort, ports: InterpreterPorts): StepInterpreter =>
	async (step, ctx) => {
		const s = step as AIAgentStep;
		// The effective ceiling is the per-subtree one when a SubWorkflow narrowed
		// it (ctx.capabilities), else the workflow's frozen caps. The agent can
		// never exceed it (fail-closed intersection inside the loop).
		const frozenCapabilities = ctx.capabilities ?? ports.capabilities;
		const result = await runAgentLoop(
			{
				generate: (messages) =>
					ai({
						messages,
						...(s.provider ? { provider: s.provider } : {}),
						...(s.model ? { model: s.model } : {}),
					}),
				dispatchTool: (call: AgentToolCall) => dispatchAgentTool(ports, call, s),
			},
			{
				instructions: s.instructions,
				tools: s.tools,
				frozenCapabilities,
				...(s.maxIterations !== undefined ? { maxIterations: s.maxIterations } : {}),
			},
		);
		// A generate failure is a step failure (the run records it); a loop that
		// finished — even at its iteration ceiling — is a success carrying its
		// transcript, so a downstream step can read the answer.
		if (result.stopReason === AgentStopReason.GenerateFailed) {
			return { ok: false, error: result.error ?? "ai-agent-generate-failed", retriable: false };
		}
		return { ok: true, output: result };
	};

/** Dispatch an agent tool call as an intent. The loop has already proved the
 *  tool is in the offered (intersected) set; this maps the call to the intent
 *  bus, carrying the tool's declared `entityType` (NOT a model-supplied one) so
 *  the dispatch stays inside the tool's declared scope. */
function dispatchAgentTool(
	ports: InterpreterPorts,
	call: AgentToolCall,
	step: AIAgentStep,
): Promise<unknown> {
	const tool = step.tools.find((t) => t.verb === call.tool);
	return ports.intents.dispatch(call.tool, tool?.entityType, call.args);
}

/**
 * Build the core-set `InterpreterRegistry` from the host ports. Trigger is
 * intentionally absent — the runner handles it as a no-op. Hand the result
 * to `new WorkflowRunner(registry, …)`.
 */
export function createCoreInterpreters(ports: InterpreterPorts): InterpreterRegistry {
	return {
		[StepKind.Intent]: intentInterpreter(ports),
		[StepKind.Entity]: entityInterpreter(ports),
		[StepKind.Notify]: notifyInterpreter(ports),
		[StepKind.Wait]: waitInterpreter(ports),
		[StepKind.Branch]: branchInterpreter(ports),
		[StepKind.ForEach]: forEachInterpreter(ports),
		[StepKind.SubWorkflow]: subWorkflowInterpreter(ports),
		[StepKind.Code]: codeInterpreter(),
		// 11b.8 — registered only when the host wires egress, so a build
		// without it keeps HTTP a cleanly-failing gated kind.
		...(ports.http ? { [StepKind.HTTP]: httpInterpreter(ports.http) } : {}),
		// IE-8 — registered only when the host wires the export service.
		...(ports.exporter ? { [StepKind.Export]: exportInterpreter(ports.exporter) } : {}),
		// 11b.7 — registered only when the host wires the AI broker, so a build
		// without it keeps AICall/AIAgent cleanly-failing gated kinds.
		...(ports.ai
			? {
					[StepKind.AICall]: aiCallInterpreter(ports.ai),
					[StepKind.AIAgent]: aiAgentInterpreter(ports.ai, ports),
				}
			: {}),
	};
}

/** Re-exported for adapters/tests that build a partial port set. */
export type { RunContext };

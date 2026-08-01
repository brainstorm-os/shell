/**
 * `AutomationsHost` (11b.6) — the per-vault orchestrator that finally makes
 * the automations engine *fire*. It owns the `SchedulerService`, drains it on
 * a real timer, and routes each due fire to the right runner: a workflow fire
 * → `WorkflowRunner` (then persist a `WorkflowRun/v1`), a reminder fire →
 * `ReminderRunner`. It also runs `EntityEvent` workflows off an entity-change
 * stream and `Manual` workflows on demand (`runNow`).
 *
 * Everything IO is injected (load a workflow's steps+caps, build cap-scoped
 * interpreter ports, persist a run, the entity-change source, the clock, the
 * interval factory) so the whole fire→run→persist orchestration is testable
 * in-process — the shell wiring (session-open registration that backs these
 * ports with the broker + entities service) is the thin deployment glue.
 *
 * Capability discipline (doc 39 §Capabilities): each workflow runs under its
 * **own** frozen capability set — the host asks `makeInterpreterPorts(caps)`
 * per fire, so the host services' ledger checks enforce the three-tier model
 * per workflow, never a blanket grant.
 */

import {
	AgentEventKind,
	AgentEventOutcome,
	AgentRunOutcome,
	AgentRunSurface,
	type EntityEventVerb,
	type WorkflowRunDef,
	WorkflowRunStatus,
	type WorkflowStep,
	aggregateWorkflowCapabilities,
	collectWorkflowAgentTools,
	missingCapabilities,
	workflowStepEvents,
} from "@brainstorm-os/sdk-types";
import type { UiNotification } from "../ui/notify-host";
import type { ItemAlertRegistration } from "./item-alerts";
import type { ReminderRunner } from "./reminder-runner";
import type { SchedulerService } from "./scheduler-service";
import { type InterpreterPorts, createCoreInterpreters } from "./step-interpreters";
import type { TimeTriggerConfig } from "./trigger-schedule";
import { type WorkflowRunResult, WorkflowRunner, toWorkflowRunDef } from "./workflow-runner";

/** A workflow ready to run: its steps + the frozen caps it executes under. */
export type LoadedWorkflow = { steps: WorkflowStep[]; capabilities: string[] };

/** Agent-12a — the structural slice of `AgentTraceRecorder` the host drives
 *  (injected so the fire→run→persist orchestration stays fake-testable). */
export type AutomationsTracePort = {
	beginRun(input: {
		surface: AgentRunSurface;
		agent: string;
		conversationId?: string | null;
		workflowRunId?: string | null;
	}): Promise<string | null>;
	event(
		runId: string,
		input: {
			kind: AgentEventKind;
			tool?: string;
			capability?: string | null;
			outcome?: AgentEventOutcome;
			detail?: string | null;
			durationMs?: number;
		},
	): Promise<void>;
	events(
		runId: string,
		drafts: ReadonlyArray<ReturnType<typeof workflowStepEvents>[number]>,
	): Promise<void>;
	endRun(runId: string, outcome?: AgentRunOutcome): Promise<void>;
	attachWorkflowRunId(runId: string, workflowRunId: string): Promise<void>;
};

/** An entity create/update/delete, as seen by `EntityEvent` triggers. */
export type EntityChange = {
	verb: EntityEventVerb;
	entityId: string;
	type: string;
};

/** Subscribe to entity changes; returns an unsubscribe. Backed in production
 *  by the entities service's post-commit emitter (the remaining wiring). */
export type EntityChangeSource = {
	subscribe(listener: (change: EntityChange) => void): () => void;
};

/** An `EntityEvent` trigger: run `workflowId` when `verb` happens on `type`. */
export type EntityEventTrigger = {
	workflowId: string;
	type: string;
	verb: EntityEventVerb;
};

/** A `Webhook` trigger (11b.8): run `workflowId` when an inbound request hits
 *  `/wh/<routeId>/<secret>`. The secret is verified constant-time by the
 *  ingress plane (loopback listener / relay client) before a hit is emitted. */
export type WebhookTrigger = {
	workflowId: string;
	routeId: string;
	secret: string;
};

/** What an authenticated inbound webhook dispatches to (Connector-6). */
export enum WebhookTargetKind {
	/** 11b.8 — run a workflow under its own frozen caps. */
	Workflow = "workflow",
	/** Connector-6 — run `connectors.sync(mappingRef)` (doorbell semantics:
	 *  the payload is discarded; the provider delta API is the source of
	 *  truth, so a hostile body can never enter the projection). */
	ConnectorSync = "connector-sync",
}

/** A webhook route as the ingress planes hold it: the path key, the secret
 *  custody (plaintext for workflow triggers — the `Trigger/v1` entity owns
 *  that secret — or a SHA-256 digest for connector endpoints, which are
 *  hash-only at rest), and the dispatch target. A route with neither
 *  verifier authenticates nothing (fail-closed). */
export type WebhookRoute = {
	routeId: string;
	targetKind: WebhookTargetKind;
	targetId: string;
	/** Plaintext shared secret (workflow triggers). */
	secret?: string;
	/** Hex SHA-256 of the secret (connector endpoints — plaintext is never
	 *  stored; the ingress plane hashes the presented secret to compare). */
	secretSha256?: string;
};

/** Connector-6 — one connector webhook endpoint, as the wiring reads it from
 *  the registry store: an authenticated hit on `routeId` runs
 *  `connectors.sync(mappingId)`. Shell-internal (the digest never reaches an
 *  app); `connectorAppId` is the app whose `network.ingress` grant gates the
 *  route. */
export type ConnectorWebhookRegistration = {
	mappingId: string;
	routeId: string;
	secretSha256: string;
	connectorAppId: string;
};

/** A verified inbound webhook, as the ingress plane hands it to the host —
 *  the secret has already been matched, so it never rides the hit. */
export type WebhookHit = {
	targetKind: WebhookTargetKind;
	targetId: string;
	routeId: string;
	method: string;
	headers: Record<string, string>;
	bodyText: string;
};

/** The inbound-webhook plane (loopback listener and/or relay client). The host
 *  hands it the active route table; the plane authenticates each request
 *  (constant-time secret match), forms its own HTTP response, and emits a hit
 *  only for authenticated requests. Injected so the host is testable with a
 *  fake and inert (undefined) without `network.ingress`. */
export type WebhookIngressPort = {
	/** Replace the active route set. Idempotent — re-registering overwrites. */
	register(routes: readonly WebhookRoute[]): void;
	/** Subscribe to authenticated inbound hits; returns an unsubscribe. */
	subscribe(listener: (hit: WebhookHit) => void): () => void;
};

/** A `FileWatch` trigger (11b.10): run `workflowId` when the file behind
 *  `watchId` (a persistent file-watch grant) changes on disk. */
export type FileWatchTrigger = {
	workflowId: string;
	watchId: string;
};

/** A file-change hit, as the watch plane hands it to the host. `kind` is the
 *  `WatchEventKind` wire value (`changed` / `errored`); typed as a string so
 *  the host stays decoupled from the files service. */
export type FileWatchHit = {
	workflowId: string;
	watchId: string;
	kind: string;
};

/** The file-watch plane (backed by the files-host watcher + the persistent
 *  grant store). The host hands it the active watch set; the plane re-mints a
 *  live handle per `watchId` and emits a hit when the file changes. Injected so
 *  the host is testable with a fake and inert (undefined) in tests. */
export type FileWatchPort = {
	/** Replace the active watch set. Idempotent — re-registering overwrites. */
	register(watches: readonly FileWatchTrigger[]): void;
	/** Subscribe to file-change hits; returns an unsubscribe. */
	subscribe(listener: (hit: FileWatchHit) => void): () => void;
};

/** The entity-derived schedule to register on vault open. Entities are the
 *  source of truth — re-registering on each boot recomputes the next fire
 *  from `now` (a late wake jumps to the next future slot, doc 39). */
export type ScheduleRegistration = {
	workflows: Array<{ triggerId: string; workflowId: string; config: TimeTriggerConfig | null }>;
	reminders: Array<{ reminderId: string; config: TimeTriggerConfig | null }>;
	entityEvents: EntityEventTrigger[];
	/** 11b.8 — inbound-webhook triggers. Registered with the ingress plane on
	 *  hydrate; empty (and the plane inert) without `network.ingress`. Optional
	 *  like `syncMappings`/`itemAlerts` so prior callers need no change. */
	webhooks?: WebhookTrigger[];
	/** Connector-6 — connector webhook endpoints. An authenticated hit is a
	 *  doorbell for `connectors.sync(mappingId)` (payload discarded). The
	 *  wiring derives these from the registry store, already filtered to
	 *  connector apps holding `network.ingress` (fail-closed). Optional. */
	connectorWebhooks?: ConnectorWebhookRegistration[];
	/** 11b.10 — file-watch triggers. Registered with the watch plane on hydrate;
	 *  each re-mints a live handle from its persistent grant. Optional. */
	fileWatches?: FileWatchTrigger[];
	/** Connector-4 — each `SyncMapping`'s scheduled pull. The mapping id is
	 *  both the scheduler trigger id and the routing key. Optional so prior
	 *  callers (pre-connector) need no change. */
	syncMappings?: Array<{ mappingId: string; config: TimeTriggerConfig | null }>;
	/** 9.14.9b — task due/scheduled + calendar event alerts derived from the
	 *  vault's Task/Event rows, so they fire with the app closed. The
	 *  notification is precomputed at derive time; a task/event write
	 *  re-derives (the wiring's rehydrate), so e.g. a completed task's alert
	 *  unregisters instead of firing stale. Optional like `syncMappings`. */
	itemAlerts?: ItemAlertRegistration[];
	/** 11b.10 — workflow ids bound to an enabled `Startup` trigger. They fire
	 *  exactly once per host lifetime (shell launch), in `start()`, NOT on
	 *  every re-hydrate — so adding a Startup workflow mid-session waits for
	 *  the next launch. Optional like the fields above. */
	startups?: string[];
};

/** Connector-4 — drives one `SyncMapping`'s pull (→ `connectors.sync`). */
export type ConnectorSyncPort = {
	runSync(mappingId: string): Promise<unknown>;
};

/** Injectable timer (mirrors `setInterval`/`clearInterval`) so tests drive
 *  the drain loop deterministically. */
export type IntervalFactory = {
	set(handler: () => void, ms: number): ReturnType<typeof setInterval>;
	clear(handle: ReturnType<typeof setInterval>): void;
};

export const productionIntervalFactory: IntervalFactory = {
	set: (handler, ms) => setInterval(handler, ms),
	clear: (handle) => clearInterval(handle),
};

export type AutomationsHostPorts = {
	scheduler: SchedulerService;
	reminderRunner: ReminderRunner;
	/** Connector-4 — the sync engine a `SyncMapping` fire routes to. */
	connectorSync?: ConnectorSyncPort;
	/** Connector-6 — re-check, against the LIVE ledger, that a webhook-driven
	 *  sync is still permitted (the endpoint's connector app still holds
	 *  `network.ingress`) immediately BEFORE each dispatch. Mirrors
	 *  `appCapabilities`' per-fire thunk: a Settings revoke takes effect on the
	 *  next inbound hit, not on the next entity-write re-derive — otherwise a
	 *  revoked app's endpoint keeps pulling from the provider and writing
	 *  entities for as long as nothing else happens to re-hydrate. Absent ⇒ the
	 *  registered route set is the only gate (tests / partial wirings). Applies
	 *  ONLY to the webhook path; Connector-4's SCHEDULED mapping fires are
	 *  unaffected (they are not an ingress surface). */
	connectorWebhookAllowed?(mappingId: string): Promise<boolean>;
	/** 9.14.9b — posts a due item alert through the shared ui notify host.
	 *  Absent keeps item alerts registered but silent (tests / partial
	 *  wirings), mirroring `connectorSync`'s optionality. */
	postAlert?(notification: UiNotification): void;
	/** Load a workflow's steps + frozen caps, or `null` if gone/disabled. */
	loadWorkflow(workflowId: string): Promise<LoadedWorkflow | null>;
	/** Build interpreter ports scoped to a workflow's caps (three-tier). */
	makeInterpreterPorts(caps: readonly string[]): InterpreterPorts;
	/** Persist a finished run (entities.create `WorkflowRun/v1`). Returning
	 *  the created entity's id lets the Agent-12a trace back-link it; a void
	 *  return (older wirings/tests) simply skips the back-link. */
	persistRun(run: WorkflowRunDef): Promise<string | null> | Promise<void>;
	/** Agent-12a — the trace recorder port. The host opens one trace run per
	 *  workflow invocation (surface `automation`, agent = `traceAgent`),
	 *  before the runner starts so live `ai_usage` rows join it, and maps the
	 *  step log through the metadata-only codec on completion. Absent =
	 *  untraced (minimal test wirings). */
	trace?: AutomationsTracePort;
	/** The principal automation runs act as (the automations app id). */
	traceAgent?: string;
	/** The automations app's granted capability set — the outer ceiling of
	 *  the three-tier model (doc 39 §Capabilities). A workflow's declared
	 *  caps must be a subset of these; enforced at run time, fail-closed.
	 *  A thunk reads the LIVE ledger per fire, so a Settings revoke takes
	 *  effect on the next run, not the next vault open. */
	appCapabilities: readonly string[] | (() => Promise<readonly string[]> | readonly string[]);
	clock(): number;
	entityChanges?: EntityChangeSource;
	/** 11b.8 — inbound-webhook plane. Absent keeps webhook triggers registered
	 *  but never firing (no `network.ingress` / tests). */
	webhookIngress?: WebhookIngressPort;
	/** 11b.10 — file-watch plane. Absent keeps file-watch triggers registered
	 *  but never firing (tests / a headless host). */
	fileWatch?: FileWatchPort;
	/** Drain interval; defaults to 5s. */
	intervalMs?: number;
	intervals?: IntervalFactory;
	/** Failure sink for fire errors (defaults to console.error). */
	onError?(context: string, error: unknown): void;
};

const DEFAULT_INTERVAL_MS = 5_000;

export class AutomationsHost {
	private readonly reminderIds = new Set<string>();
	private readonly syncMappingIds = new Set<string>();
	private readonly itemAlertsById = new Map<string, UiNotification>();
	private entityEvents: EntityEventTrigger[] = [];
	private webhooks: WebhookTrigger[] = [];
	private connectorWebhooks: ConnectorWebhookRegistration[] = [];
	/** Per-mapping coalescer: a webhook storm collapses to one in-flight sync
	 *  plus at most one trailing run (the rate bound — sync frequency is
	 *  capped by sync duration, never by inbound request rate). */
	private readonly connectorSyncStates = new Map<string, { queued: boolean }>();
	private webhookIngress: WebhookIngressPort | undefined;
	private fileWatches: FileWatchTrigger[] = [];
	private startups: string[] = [];
	/** Startups fire once per host lifetime — this latches after the first
	 *  `start()` so a later re-hydrate + re-start never re-fires them. */
	private startupsFired = false;
	private timer: ReturnType<typeof setInterval> | null = null;
	private unsubscribe: (() => void) | null = null;
	private unsubscribeWebhooks: (() => void) | null = null;
	private unsubscribeFileWatch: (() => void) | null = null;
	private readonly intervals: IntervalFactory;

	constructor(private readonly ports: AutomationsHostPorts) {
		this.intervals = ports.intervals ?? productionIntervalFactory;
		this.webhookIngress = ports.webhookIngress;
	}

	/** Swap the inbound-webhook plane after construction. Production reads the
	 *  `network.ingress` grant async at start and only then binds a listener, so
	 *  it sets the port here before `hydrate`/`start`. Setting it live re-points
	 *  the subscription (drops the old, wires the new) if already started. */
	setWebhookIngress(port: WebhookIngressPort | undefined): void {
		if (port === this.webhookIngress) return;
		const wasSubscribed = this.unsubscribeWebhooks !== null;
		this.unsubscribeWebhooks?.();
		this.unsubscribeWebhooks = null;
		this.webhookIngress = port;
		if (port) {
			port.register(this.webhookRoutes());
			// Re-point a live subscription — and if the host is already running
			// (a mid-session bind: the FIRST endpoint minted after start()),
			// subscribe now or hits would be dropped until the next start().
			if (wasSubscribed || this.timer !== null) {
				this.unsubscribeWebhooks = port.subscribe((hit) => {
					void this.onWebhookHit(hit);
				});
			}
		}
	}

	/** Register the entity-derived schedule with the scheduler. Idempotent —
	 *  re-registering a trigger id overwrites its prior schedule. */
	async hydrate(registration: ScheduleRegistration, now: number): Promise<void> {
		// Re-derive from scratch — entities are the source of truth, so a
		// reminder/event removed since the last hydrate must not linger in the
		// routing set (a stale id could mis-route a later workflow fire).
		this.reminderIds.clear();
		this.syncMappingIds.clear();
		this.itemAlertsById.clear();
		this.entityEvents = [...registration.entityEvents];
		this.webhooks = [...(registration.webhooks ?? [])];
		this.connectorWebhooks = [...(registration.connectorWebhooks ?? [])];
		this.webhookIngress?.register(this.webhookRoutes());
		this.fileWatches = [...(registration.fileWatches ?? [])];
		this.ports.fileWatch?.register(this.fileWatches);
		this.startups = [...(registration.startups ?? [])];
		for (const w of registration.workflows) {
			if (w.config) await this.ports.scheduler.register(w.triggerId, [w.workflowId], w.config, now);
		}
		for (const r of registration.reminders) {
			this.reminderIds.add(r.reminderId);
			if (r.config) await this.ports.scheduler.register(r.reminderId, [r.reminderId], r.config, now);
		}
		for (const m of registration.syncMappings ?? []) {
			this.syncMappingIds.add(m.mappingId);
			if (m.config) await this.ports.scheduler.register(m.mappingId, [m.mappingId], m.config, now);
		}
		for (const a of registration.itemAlerts ?? []) {
			this.itemAlertsById.set(a.alertId, a.notification);
			await this.ports.scheduler.register(a.alertId, [a.alertId], a.config, now);
		}
	}

	/** Start the drain loop + entity-change subscription. */
	start(): void {
		if (this.timer === null) {
			const intervalMs = this.ports.intervalMs ?? DEFAULT_INTERVAL_MS;
			this.timer = this.intervals.set(() => {
				void this.tick(this.ports.clock());
			}, intervalMs);
		}
		if (!this.unsubscribe && this.ports.entityChanges) {
			this.unsubscribe = this.ports.entityChanges.subscribe((change) => {
				void this.onEntityChange(change);
			});
		}
		if (!this.unsubscribeWebhooks && this.webhookIngress) {
			this.unsubscribeWebhooks = this.webhookIngress.subscribe((hit) => {
				void this.onWebhookHit(hit);
			});
		}
		if (!this.unsubscribeFileWatch && this.ports.fileWatch) {
			this.unsubscribeFileWatch = this.ports.fileWatch.subscribe((hit) => {
				void this.onFileWatchHit(hit);
			});
		}
		// 11b.10 — Startup workflows fire once, on the first start() of this host
		// (shell launch). The latch survives a stop()/start() (host-takeover
		// re-claim) so they never double-fire within a session.
		if (!this.startupsFired) {
			this.startupsFired = true;
			void this.fireStartups();
		}
	}

	/** Fire every `Startup`-triggered workflow once. Each runs under its own
	 *  caps via the shared `runWorkflow` path; one failure never blocks the
	 *  rest. */
	private async fireStartups(): Promise<void> {
		for (const workflowId of this.startups) {
			await this.runWorkflow(workflowId, `startup:${workflowId}`, { startup: true }).catch((e) =>
				this.fail(`startup ${workflowId}`, e),
			);
		}
	}

	/** Stop the timer + unsubscribe (vault dispose). Idempotent. */
	stop(): void {
		if (this.timer !== null) {
			this.intervals.clear(this.timer);
			this.timer = null;
		}
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.unsubscribeWebhooks?.();
		this.unsubscribeWebhooks = null;
		this.unsubscribeFileWatch?.();
		this.unsubscribeFileWatch = null;
	}

	/** Drain everything due at `now`, routing each fire to its runner. */
	async tick(now: number): Promise<void> {
		let fires: Awaited<ReturnType<SchedulerService["tick"]>>;
		try {
			fires = await this.ports.scheduler.tick(now);
		} catch (e) {
			this.fail("scheduler.tick", e);
			return;
		}
		for (const fire of fires) {
			const alert = this.itemAlertsById.get(fire.workflowId);
			if (alert) {
				try {
					this.ports.postAlert?.(alert);
				} catch (e) {
					this.fail(`item alert ${fire.workflowId}`, e);
				}
			} else if (this.syncMappingIds.has(fire.workflowId)) {
				if (this.ports.connectorSync) {
					await this.ports.connectorSync
						.runSync(fire.workflowId)
						.catch((e) => this.fail(`sync ${fire.workflowId}`, e));
				}
			} else if (this.reminderIds.has(fire.workflowId)) {
				await this.ports.reminderRunner
					.fire(fire.workflowId)
					.catch((e) => this.fail(`reminder ${fire.workflowId}`, e));
			} else {
				await this.runWorkflow(fire.workflowId, fire.triggerId, {
					triggerId: fire.triggerId,
					firedAt: fire.firedAt,
				}).catch((e) => this.fail(`workflow ${fire.workflowId}`, e));
			}
		}
	}

	/** Run a workflow now (Manual trigger / "Run now" button — doc 39). */
	async runNow(workflowId: string): Promise<WorkflowRunResult | null> {
		return this.runWorkflow(workflowId, `manual:${workflowId}`, { manual: true });
	}

	/** Load → run (under the workflow's own caps) → persist the run record. */
	async runWorkflow(
		workflowId: string,
		triggeredBy: string,
		triggerPayload: unknown,
	): Promise<WorkflowRunResult | null> {
		const loaded = await this.ports.loadWorkflow(workflowId);
		if (!loaded) return null;

		// Three-tier capability enforcement at run time (doc 39 §Capabilities,
		// fail-closed). The frozen `capabilities[]` is what the user consented
		// to at save time; it is only meaningful if execution is actually
		// bounded by it. Refuse to run a workflow whose steps need more than
		// it declared, or that declared more than the app holds — otherwise a
		// workflow saved with a benign capability sheet could act with the
		// full automations-app grant set.
		const denied = await this.capabilityViolations(loaded);
		if (denied.length > 0) {
			const runEntityId = await this.persistDeniedRun(workflowId, triggeredBy, denied);
			await this.traceDeniedRun(denied, runEntityId);
			return null;
		}

		// Agent-12a — the trace run opens BEFORE the runner so the AI broker's
		// accounting rows stamp this run's id live (OQ-AO-5). Fail-soft: a null
		// id disables tracing, never the run.
		const traceRunId = await this.beginTraceRun();

		const interpreterPorts = this.ports.makeInterpreterPorts(loaded.capabilities);
		const runner = new WorkflowRunner(createCoreInterpreters(interpreterPorts), {
			clock: this.ports.clock,
		});
		const result = await runner.run({
			workflowId,
			triggeredBy,
			steps: loaded.steps,
			triggerPayload,
		});
		const runEntityId = await this.ports.persistRun(toWorkflowRunDef(result));
		if (traceRunId && this.ports.trace) {
			if (typeof runEntityId === "string" && runEntityId) {
				await this.ports.trace.attachWorkflowRunId(traceRunId, runEntityId);
			}
			await this.ports.trace.events(
				traceRunId,
				workflowStepEvents(result.stepLog, {
					tools: collectWorkflowAgentTools(loaded.steps),
					frozenCapabilities: loaded.capabilities,
				}),
			);
			await this.ports.trace.endRun(traceRunId, traceOutcomeForRun(result.status));
		}
		return result;
	}

	private async beginTraceRun(): Promise<string | null> {
		if (!this.ports.trace || !this.ports.traceAgent) return null;
		return await this.ports.trace.beginRun({
			surface: AgentRunSurface.Automation,
			agent: this.ports.traceAgent,
		});
	}

	/** A refused run is the denial-visibility case the track exists for: one
	 *  `tool-denied` row PER missing capability, run outcome `refused`. */
	private async traceDeniedRun(denied: readonly string[], runEntityId: unknown): Promise<void> {
		const traceRunId = await this.beginTraceRun();
		if (!traceRunId || !this.ports.trace) return;
		if (typeof runEntityId === "string" && runEntityId) {
			await this.ports.trace.attachWorkflowRunId(traceRunId, runEntityId);
		}
		for (const capability of [...new Set(denied)].sort()) {
			await this.ports.trace.event(traceRunId, {
				kind: AgentEventKind.ToolDenied,
				capability,
				outcome: AgentEventOutcome.Denied,
			});
		}
		await this.ports.trace.endRun(traceRunId, AgentRunOutcome.Refused);
	}

	/** The capabilities a workflow would exercise beyond what it is allowed:
	 *  steps that exceed the workflow's declared set, plus the declared set
	 *  exceeding the app's grants. Empty ⇒ cleared to run. */
	private async capabilityViolations(loaded: LoadedWorkflow): Promise<string[]> {
		const ceiling = this.ports.appCapabilities;
		const appCaps = typeof ceiling === "function" ? await ceiling() : ceiling;
		const stepCaps = aggregateWorkflowCapabilities(loaded.steps);
		return [
			...missingCapabilities(stepCaps, loaded.capabilities),
			...missingCapabilities(loaded.capabilities, appCaps),
		];
	}

	private async persistDeniedRun(
		workflowId: string,
		triggeredBy: string,
		denied: readonly string[],
	): Promise<unknown> {
		return await this.ports.persistRun({
			workflow: workflowId,
			triggeredBy,
			triggeredAt: new Date(this.ports.clock()).toISOString(),
			status: WorkflowRunStatus.Failed,
			error: `capability-denied:${[...new Set(denied)].sort().join(",")}`,
		});
	}

	private async onEntityChange(change: EntityChange): Promise<void> {
		for (const trigger of this.entityEvents) {
			if (trigger.verb !== change.verb || trigger.type !== change.type) continue;
			await this.runWorkflow(trigger.workflowId, `entity-event:${change.entityId}`, {
				entityId: change.entityId,
				type: change.type,
				verb: change.verb,
			}).catch((e) => this.fail(`entity-event ${trigger.workflowId}`, e));
		}
	}

	/** The union route table the ingress planes verify against: workflow
	 *  triggers (plaintext secret, owned by the `Trigger/v1` entity) plus
	 *  connector endpoints (hash-only custody). */
	private webhookRoutes(): WebhookRoute[] {
		return [
			...this.webhooks.map((w) => ({
				routeId: w.routeId,
				targetKind: WebhookTargetKind.Workflow,
				targetId: w.workflowId,
				secret: w.secret,
			})),
			...this.connectorWebhooks.map((c) => ({
				routeId: c.routeId,
				targetKind: WebhookTargetKind.ConnectorSync,
				targetId: c.mappingId,
				secretSha256: c.secretSha256,
			})),
		];
	}

	/** An authenticated inbound webhook (secret already verified by the ingress
	 *  plane) fires its target. A workflow target runs under the workflow's own
	 *  frozen caps with the request as trigger payload (so a `Code`/`AICall`
	 *  step can read body/headers). A connector-sync target is a doorbell: the
	 *  payload is DISCARDED and `connectors.sync(mappingId)` pulls from the
	 *  provider's API instead — hostile body bytes can never enter the
	 *  projection. Guard on the registered route set so a hit for a route no
	 *  longer registered (rehydrate race / revoke) is dropped. */
	private async onWebhookHit(hit: WebhookHit): Promise<void> {
		if (hit.targetKind === WebhookTargetKind.ConnectorSync) {
			const registered = this.connectorWebhooks.some(
				(c) => c.mappingId === hit.targetId && c.routeId === hit.routeId,
			);
			if (registered) this.dispatchConnectorWebhookSync(hit.targetId);
			return;
		}
		if (!this.webhooks.some((w) => w.workflowId === hit.targetId && w.routeId === hit.routeId)) {
			return;
		}
		await this.runWorkflow(hit.targetId, `webhook:${hit.routeId}`, {
			routeId: hit.routeId,
			method: hit.method,
			headers: hit.headers,
			body: hit.bodyText,
		}).catch((e) => this.fail(`webhook ${hit.targetId}`, e));
	}

	/** Coalesced `connectors.sync` dispatch: at most one in-flight sync per
	 *  mapping, with one trailing run if hits arrived meanwhile. A failure
	 *  drops the queued flag (the next hit re-arms) — never a retry storm.
	 *  Every iteration re-checks the live grant first, so a mid-storm revoke
	 *  stops the loop instead of riding it out. */
	private dispatchConnectorWebhookSync(mappingId: string): void {
		const inFlight = this.connectorSyncStates.get(mappingId);
		if (inFlight) {
			inFlight.queued = true;
			return;
		}
		const state = { queued: false };
		this.connectorSyncStates.set(mappingId, state);
		void (async () => {
			try {
				do {
					state.queued = false;
					if (!(await this.connectorWebhookStillAllowed(mappingId))) break;
					await this.ports.connectorSync?.runSync(mappingId);
				} while (state.queued);
			} catch (e) {
				this.fail(`connector webhook sync ${mappingId}`, e);
			} finally {
				this.connectorSyncStates.delete(mappingId);
			}
		})();
	}

	/** Fail-closed live re-check of a connector endpoint's `network.ingress`
	 *  grant. A throwing check denies — never approves. */
	private async connectorWebhookStillAllowed(mappingId: string): Promise<boolean> {
		if (!this.ports.connectorWebhookAllowed) return true;
		try {
			return await this.ports.connectorWebhookAllowed(mappingId);
		} catch {
			return false;
		}
	}

	/** A watched file changed — fire its bound workflow under the workflow's own
	 *  frozen caps. The change (watchId + kind) rides as the trigger payload.
	 *  Guarded on the registered watch set (drops a hit for a watch no longer
	 *  registered — a rehydrate race). */
	private async onFileWatchHit(hit: FileWatchHit): Promise<void> {
		if (!this.fileWatches.some((w) => w.workflowId === hit.workflowId && w.watchId === hit.watchId)) {
			return;
		}
		await this.runWorkflow(hit.workflowId, `file-watch:${hit.watchId}`, {
			watchId: hit.watchId,
			kind: hit.kind,
		}).catch((e) => this.fail(`file-watch ${hit.workflowId}`, e));
	}

	private fail(context: string, error: unknown): void {
		if (this.ports.onError) this.ports.onError(context, error);
		else console.error(`[automations] ${context} failed:`, error);
	}
}

/** Run status → trace outcome (cancel/timeout both read as `aborted`). */
function traceOutcomeForRun(status: WorkflowRunStatus): AgentRunOutcome {
	switch (status) {
		case WorkflowRunStatus.Succeeded:
			return AgentRunOutcome.Ok;
		case WorkflowRunStatus.Failed:
			return AgentRunOutcome.Error;
		default:
			return AgentRunOutcome.Aborted;
	}
}

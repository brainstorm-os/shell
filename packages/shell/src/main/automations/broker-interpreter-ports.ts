/**
 * The host glue (11b.4) — backs the pure `InterpreterPorts` with the real
 * broker service handlers, so the `WorkflowRunner`'s interpreters drive the
 * live entities / intents / notifications services.
 *
 * Every call goes out as a standard IPC envelope under the **automations
 * app's identity** carrying the **workflow's frozen capability set** — so
 * the host services' own ledger checks enforce the three-tier capability
 * model (doc 39 §Capabilities & security) exactly as they would for any app
 * call. The runner never imports the broker; this adapter is the one seam
 * between the pure interpreters and the shell's service mesh, and it is
 * testable with a fake `getServiceHandler`.
 *
 * Live registration (the timer drain loop + scheduler→runner delivery that
 * constructs these ports per fire) is the 11b.6 wiring; this slice ships the
 * adapter + its contract.
 */

import { type WorkflowStep, capabilityImplies } from "@brainstorm-os/sdk-types";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import type { EntityRecord, HttpPort, InterpreterPorts } from "./step-interpreters";

/** The single outbound-HTTP seam (the connector framework's egress shape) —
 *  production binds Net-1's `executeNetworkFetch`, so HTTP steps inherit the
 *  SSRF guard, size/time caps, and the per-host audit log. */
export type WorkflowEgress = (req: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: Uint8Array;
}) => Promise<{ status: number; body: Uint8Array }>;

/** Mirrors `broker.getServiceHandler` — a name → handler lookup. */
export type ServiceHandlerGetter = (
	name: string,
) => ((envelope: Envelope) => Promise<unknown> | unknown) | undefined;

export type BrokerPortsOptions = {
	getServiceHandler: ServiceHandlerGetter;
	/** The identity the host services see (the automations app) — the ledger
	 *  enforces this app's grants. */
	appId: string;
	/** The workflow's frozen capability set, carried on every envelope. */
	caps: readonly string[];
	/** Wait/backoff sleeper; defaults to a real `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
	/** 11b.8 — outbound HTTP for the `HTTP` step. Optional: absent keeps
	 *  the step kind gated. */
	egress?: WorkflowEgress;
};

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

function asEntityRecord(value: unknown): EntityRecord {
	const v = (value ?? {}) as Partial<EntityRecord>;
	return {
		id: typeof v.id === "string" ? v.id : "",
		type: typeof v.type === "string" ? v.type : "",
		properties:
			v.properties && typeof v.properties === "object"
				? (v.properties as Record<string, unknown>)
				: {},
	};
}

/** Build the live `InterpreterPorts` over the broker's service handlers. */
export function createBrokerInterpreterPorts(opts: BrokerPortsOptions): InterpreterPorts {
	let seq = 0;
	const call = async (service: string, method: string, arg: unknown): Promise<unknown> => {
		const handler = opts.getServiceHandler(service);
		if (!handler) throw new Error(`service-unavailable:${service}`);
		seq += 1;
		return handler({
			v: ENVELOPE_PROTOCOL_VERSION,
			msg: `wf-${service}-${method}-${seq}`,
			app: opts.appId,
			service,
			method,
			args: [arg],
			caps: [...opts.caps],
		});
	};

	return {
		intents: {
			dispatch: (verb, entityType, args) =>
				call("intents", "dispatch", {
					verb,
					payload: { ...(args ?? {}), ...(entityType ? { entityType } : {}) },
				}),
		},
		entities: {
			create: async (type, properties) =>
				asEntityRecord(await call("entities", "create", { type, properties })),
			update: async (id, patch) => asEntityRecord(await call("entities", "update", { id, patch })),
			get: async (id) => {
				const row = await call("entities", "get", { id });
				return row ? asEntityRecord(row) : null;
			},
			query: async (type, filter) => {
				// The step's declared `type` MUST win: `filter` is the untrusted
				// prior-step output, and spreading it last would let `{type: …}`
				// override the declared entity-type scope (11b.6 gate 2 — Query op).
				const rows = (await call("entities", "query", {
					query: { ...(filter ?? {}), type },
				})) as unknown[];
				return Array.isArray(rows) ? rows.map(asEntityRecord) : [];
			},
			delete: async (id) => {
				await call("entities", "delete", { id });
			},
		},
		notify: (n) =>
			call("ui", "notify", { title: n.title, ...(n.body !== undefined ? { body: n.body } : {}) }).then(
				() => undefined,
			),
		sleep: opts.sleep ?? defaultSleep,
		...(opts.egress ? { http: makeCapScopedHttpPort(opts.egress, opts.caps) } : {}),
		// IE-8 — the export service is a standard host service, so the port is
		// always wired; per-entity `entities.read:<type>` enforcement happens in
		// the handler against the workflow caps carried on the envelope.
		exporter: async (req) =>
			String(await call("export", "serializeEntities", { ids: [...req.ids], format: req.format })),
		// 11b.7 — the AI broker is a standard host service, so the port is always
		// wired; `ai.use` + `ai.provider:<id>` enforcement happens in the broker
		// against the workflow caps carried on the envelope (fail-closed). A
		// missing/unconfigured provider surfaces as the broker's `Unavailable`,
		// which the runner records as a step failure (never silent success).
		ai: async (req) => {
			const result = (await call("ai", "generate", {
				messages: [...req.messages],
				...(req.provider ? { provider: req.provider } : {}),
				...(req.model ? { model: req.model } : {}),
			})) as { content?: unknown; provider?: unknown; model?: unknown } | null;
			const content = typeof result?.content === "string" ? result.content : "";
			const provider = typeof result?.provider === "string" ? result.provider : "";
			const model = typeof result?.model === "string" ? result.model : "";
			return provider
				? { content, provenance: { provider, model, generatedAt: new Date().toISOString() } }
				: { content };
		},
		loadWorkflowSteps: async (workflowId) => {
			const entity = await call("entities", "get", { id: workflowId });
			if (!entity) return null;
			const props = asEntityRecord(entity).properties;
			if (props.enabled === false) return null;
			if (!Array.isArray(props.steps)) return null;
			const capabilities = Array.isArray(props.capabilities)
				? (props.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
				: [];
			return { steps: props.steps as WorkflowStep[], capabilities };
		},
		capabilities: [...opts.caps],
	};
}

/**
 * SECURITY (11b.8) — the per-fire egress gate. The HTTP step's capability
 * vocabulary is `network.egress:<origin>` (sdk-types `stepCapabilities`);
 * the host's three-tier check already proved the workflow's *declared*
 * steps stay within its frozen sheet, and this guard re-checks the actual
 * request origin against that same frozen set at send time — fail-closed,
 * so a step whose URL escapes its declared origin (or a caller bypassing
 * the static check) never reaches the network.
 */
export function makeCapScopedHttpPort(egress: WorkflowEgress, caps: readonly string[]): HttpPort {
	return async (req) => {
		const origin = new URL(req.url).origin;
		const required = `network.egress:${origin}`;
		if (!caps.some((held) => capabilityImplies(held, required))) {
			throw new Error(`http-egress-denied:${origin}`);
		}
		const response = await egress({
			url: req.url,
			method: req.method,
			...(req.body !== undefined
				? { body: req.body, headers: { "Content-Type": "application/json" } }
				: {}),
		});
		return {
			status: response.status,
			bodyText: new TextDecoder("utf-8", { fatal: false }).decode(response.body),
		};
	};
}

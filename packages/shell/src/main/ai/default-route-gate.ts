/**
 * Agent-14 — the default-routing gate. A custom endpoint is arbitrary code the
 * user pointed the transcript at, so reaching one needs `ai.provider:<id>`.
 * That gate keyed on the PINNED id, so once the user made a custom endpoint
 * the default, an unpinned call reached it on `ai.use` alone.
 *
 * Rather than re-implement the gate, an unpinned model call is pinned to the
 * resolved default when that default is custom: the request the service gates
 * is then the request it routes (check and forward the same value), and a
 * default changed mid-call cannot slip a different provider past the check.
 */

import { isCustomProviderId } from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";

const MODEL_VERBS: ReadonlySet<string> = new Set(["generate", "cost", "transform", "extract"]);

export function pinCustomDefaultProvider(
	handler: ServiceHandler,
	defaultProviderId: () => string | null,
): ServiceHandler {
	return (envelope, source) => {
		if (!MODEL_VERBS.has(envelope.method)) return handler(envelope, source);
		const [req, ...rest] = envelope.args;
		if (!req || typeof req !== "object" || Array.isArray(req)) return handler(envelope, source);
		if ((req as { provider?: unknown }).provider !== undefined) return handler(envelope, source);
		const resolved = defaultProviderId();
		if (!resolved || !isCustomProviderId(resolved)) return handler(envelope, source);
		return handler({ ...envelope, args: [{ ...req, provider: resolved }, ...rest] }, source);
	};
}

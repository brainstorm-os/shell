/**
 * BP Hook module router — Stage 9.3.3.3.
 *
 * v1 is structural dispatch only: cross-iframe DOM refs can't reach the
 * host across opaque-origin sandboxes, so any non-null `node` returns
 * `NOT_IMPLEMENTED` (BP allows the embedder to decline; the block must
 * paint its property itself). Destroys (`node: null`) are idempotent OK.
 * The real overlay UI + per-type cap gate are OQ-BP-5 forward work.
 */

import { BpErrorCode } from "./envelope";
import type { BpModuleHandler, BpModuleResponse } from "./router";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(reason: string): BpModuleResponse {
	return { errors: [{ code: BpErrorCode.InvalidInput, message: reason }] };
}

function notImplemented(reason: string): BpModuleResponse {
	return { errors: [{ code: BpErrorCode.NotImplemented, message: reason }] };
}

interface ParsedHook {
	readonly ok: true;
	readonly type: string;
	readonly entityId: string;
	readonly path: string;
	readonly hookId: string | null;
	readonly node: Record<string, unknown> | null;
}

/** Validate the structural shape of a `hook` envelope's `data` payload.
 *  Returns the normalised fields, or an error response. */
function parseHookData(raw: unknown): ParsedHook | BpModuleResponse {
	if (!isRecord(raw)) return invalid("hook: data must be an object");
	const type = raw.type;
	if (typeof type !== "string" || type === "") return invalid("hook: type required");
	const entityId = raw.entityId;
	if (typeof entityId !== "string" || entityId === "") return invalid("hook: entityId required");
	const path = raw.path;
	if (typeof path !== "string") return invalid("hook: path required");
	if (raw.hookId !== null && typeof raw.hookId !== "string") {
		return invalid("hook: hookId must be string or null");
	}
	if (raw.node !== null && !isRecord(raw.node)) {
		return invalid("hook: node must be object or null");
	}
	return {
		ok: true,
		type,
		entityId,
		path,
		hookId: raw.hookId as string | null,
		node: raw.node as Record<string, unknown> | null,
	};
}

export function makeBpHookRouter(): BpModuleHandler {
	return (request) => {
		if (request.messageName !== "hook") {
			return notImplemented(`Unknown hook messageName: ${request.messageName}`);
		}

		const parsed = parseHookData((request as { data?: unknown }).data);
		if (parsed === null || !("ok" in parsed)) return parsed;

		// Destroy semantics: `node: null` with a hookId means "tear down
		// the hook I previously registered". Since we never register
		// anything in v1, this is idempotent — return OK so a block that
		// politely cleans up after itself doesn't see a spurious error.
		if (parsed.node === null) {
			if (parsed.hookId === null) {
				return invalid("hook: cannot destroy without hookId");
			}
			return { data: { hookId: parsed.hookId } };
		}

		// Real registration: forward-stage UI work (OQ-BP-5). The block
		// must cope — BP allows the embedder to decline a hook.
		return notImplemented(
			`hook: host overlay rendering not yet supported (type=${parsed.type}) — OQ-BP-5; block must paint this property itself`,
		);
	};
}

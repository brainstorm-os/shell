/**
 * BP wire-format types + shell-side enums.
 *
 * Stage 9.3.3.1 — every `@blockprotocol/*` import in the shell goes
 * through this file so the security-review surface is enumerable
 * (mirrors the crypto-routing rule in).
 * The four packages we depend on are pinned to exact versions in
 * `packages/shell/package.json` — protocol-version-sensitive wire format,
 * a silent minor bump is a contract risk.
 *
 * Type-only re-exports: `Message`, `MessageContents`, `MessageData`,
 * `MessageError` come straight from `@blockprotocol/core` and describe
 * the postMessage envelope the block ↔ host exchange. Everything else
 * here is shell-side (the per-module + per-error enum centralisations
 * required by CLAUDE.md §"Enums, not raw string discriminators").
 */

export type { Message, MessageData, MessageError } from "@blockprotocol/core";

/** A BP-shaped message we treat as a request from a block. `Message`
 *  from `@blockprotocol/core` over-narrows `errors` to a 0-length tuple
 *  by default (the generic `ErrorCode = null` case), which makes route-
 *  side response synthesis awkward. We work in this slightly relaxed
 *  shape on the host and reflect it back as a `Message` on the wire. */
export interface BpEnvelope {
	requestId: string;
	messageName: string;
	module: string;
	source: BpSource;
	timestamp: string;
	data?: unknown;
	errors?: ReadonlyArray<{ code: string; message: string; extensions?: unknown }>;
}

/** The BP modules we route. v1 = the two surfaces with `host`-side
 *  message handlers: Graph (entity CRUD + query + file upload) and
 *  Hook (host-rendered property surfaces). Type-system is consumed
 *  internally (validator), not a wire module. */
export enum BpModule {
	Graph = "graph",
	Hook = "hook",
}

/** Error codes the BP modules declare for their `*Response` shapes,
 *  plus one shell-specific code for "host policy rejects this", which
 *  9.3.3.2 needs for `createEntityType` (types are manifest-declared,
 *  never runtime-mutable — OQ-7). The wire form is exactly these
 *  strings; the enum centralises them per CLAUDE.md. */
export enum BpErrorCode {
	Forbidden = "FORBIDDEN",
	InvalidInput = "INVALID_INPUT",
	NotFound = "NOT_FOUND",
	NotImplemented = "NOT_IMPLEMENTED",
	InternalError = "INTERNAL_ERROR",
	NotPermitted = "NOT_PERMITTED",
}

/** The fixed sender values on a BP envelope. Blocks send with
 *  `source: "block"`; the host responds with `source: "embedder"`. */
export enum BpSource {
	Block = "block",
	Embedder = "embedder",
}

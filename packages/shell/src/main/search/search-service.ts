/**
 * Broker service handler for `search`.
 *
 * Methods:
 *   - query({ text, types?, limit? }) → SearchHit[]
 *
 * Capability gating happens in the broker via the envelope's `caps` field;
 * the SDK proxy declares `search.read` (default-minimum grant — see
 * `capabilities/default-grants.ts`). Throws `Unavailable` when no vault
 * session is active (no indexer → no index → can't answer); throws
 * `Invalid` on malformed args or unknown methods.
 *
 * The handler is thin on purpose — all the FTS5 work + query-string
 * escaping lives in `SearchIndexer`. Keeps the broker surface easy to
 * audit and the indexer easy to test in isolation.
 */

import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { reciprocalRankFusion } from "./hybrid-fusion";
import {
	type IndexerQuery,
	type SearchHit,
	type SearchIndexer,
	clampLimit,
} from "./search-indexer";
import type { VectorIndexer } from "./vector-indexer";

export type SearchServiceOptions = {
	/** Resolve the active vault's indexer. Returns null when no vault
	 *  session is open — the handler maps that to `Unavailable`. */
	getIndexer: () => SearchIndexer | null;
	/** Resolve the active vault's vector indexer for `search.hybrid`. Optional
	 *  / null when sqlite-vec didn't load or vector indexing is disabled — the
	 *  hybrid path then degrades to lexical-only. */
	getVectorIndexer?: () => VectorIndexer | null;
};

export function makeSearchServiceHandler(options: SearchServiceOptions): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		const indexer = options.getIndexer();
		if (!indexer) {
			throw makeError("Unavailable", "search index is not available (no active vault session)");
		}
		switch (envelope.method) {
			case "query":
				return indexer.query(requireQuery(envelope));
			case "hybrid":
				return await runHybridQuery(
					indexer,
					options.getVectorIndexer?.() ?? null,
					requireQuery(envelope),
				);
			default:
				throw makeError("Invalid", `unknown search method: ${envelope.method}`);
		}
	};
}

/** `search.hybrid` — fuse the lexical (BM25) + vector (cosine) rankings via
 *  RRF. Degrades to pure lexical when no vector indexer is wired or its index
 *  is empty (the gated 11.2 stub state / sqlite-vec absent), so the verb is
 *  always answerable and silently sharpens once real embeddings land (11.3).
 *  Lexical hits keep their full metadata (snippet/title); a vector-only id
 *  gets a minimal hit (no snippet — it didn't match a lexical token).
 *
 *  Exported so the privileged launcher search handler (`search:query`) shares
 *  the exact fusion path — 11.4 makes hybrid the launcher default. */
export async function runHybridQuery(
	indexer: SearchIndexer,
	vectorIndexer: VectorIndexer | null,
	query: IndexerQuery,
): Promise<SearchHit[]> {
	const lexical = indexer.query(query);
	const vector = vectorIndexer
		? await vectorIndexer.query(query.text, query.limit, query.types)
		: [];
	if (vector.length === 0) return lexical;

	const fused = reciprocalRankFusion([
		lexical.map((h) => ({ id: h.entityId })),
		vector.map((h) => ({ id: h.entityId })),
	]);
	const lexById = new Map(lexical.map((h) => [h.entityId, h]));
	const vecById = new Map(vector.map((h) => [h.entityId, h]));
	return fused.slice(0, clampLimit(query.limit)).map(({ id, score }) => {
		const lex = lexById.get(id);
		if (lex) return { ...lex, score };
		const vec = vecById.get(id);
		return {
			entityId: id,
			type: vec?.type ?? "",
			ownerAppId: vec?.ownerAppId ?? "",
			title: "",
			snippet: "",
			score,
			updatedAt: vec?.updatedAt ?? 0,
		} satisfies SearchHit;
	});
}

function makeError(kind: "Unavailable" | "Invalid", message: string): Error {
	const err = new Error(message);
	err.name = kind;
	return err;
}

function requireQuery(envelope: Envelope): IndexerQuery {
	const [arg] = envelope.args as [unknown];
	if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
		throw makeError("Invalid", "search.query: argument must be an object");
	}
	const a = arg as Record<string, unknown>;
	if (typeof a.text !== "string") {
		throw makeError("Invalid", "search.query: { text } must be a string");
	}
	const out: IndexerQuery = { text: a.text };
	if (a.types !== undefined) {
		if (!Array.isArray(a.types) || a.types.some((t) => typeof t !== "string" || t.length === 0)) {
			throw makeError("Invalid", "search.query: { types } must be an array of non-empty strings");
		}
		out.types = a.types as string[];
	}
	if (a.excludeTypes !== undefined) {
		if (
			!Array.isArray(a.excludeTypes) ||
			a.excludeTypes.some((t) => typeof t !== "string" || t.length === 0)
		) {
			throw makeError(
				"Invalid",
				"search.query: { excludeTypes } must be an array of non-empty strings",
			);
		}
		out.excludeTypes = a.excludeTypes as string[];
	}
	if (a.limit !== undefined) {
		if (typeof a.limit !== "number" || !Number.isFinite(a.limit)) {
			throw makeError("Invalid", "search.query: { limit } must be a finite number");
		}
		out.limit = a.limit;
	}
	return out;
}

/**
 * Bridge the semantic-model download status (`embedder-status.ts`) into a
 * background-activity operation. Pure so the mapping is unit-tested without the
 * store or the embedder.
 */

import { ActivityKind, ActivityPhase, type BackgroundOperation } from "../../activity-types";
import { EmbedderPhase, type SemanticModelStatus } from "../search/embedder-status";

export const SEMANTIC_MODEL_OP_ID = "semantic-model-download";

/** The activity operation for a given model status, or null when nothing should
 *  show. `Downloading` → a live op carrying the byte percent; `Failed` → a
 *  visible Error op (cleared when the next embed retries). `Idle` / `Ready` /
 *  `Absent` are not in-flight work → null (the op is cleared). */
export function operationFromSemanticStatus(
	status: SemanticModelStatus,
): BackgroundOperation | null {
	switch (status.phase) {
		case EmbedderPhase.Downloading:
			return {
				id: SEMANTIC_MODEL_OP_ID,
				kind: ActivityKind.ModelDownload,
				phase: ActivityPhase.Running,
				percent: status.percent,
				detail: null,
			};
		case EmbedderPhase.Failed:
			return {
				id: SEMANTIC_MODEL_OP_ID,
				kind: ActivityKind.ModelDownload,
				phase: ActivityPhase.Error,
				percent: null,
				detail: status.error,
			};
		default:
			return null;
	}
}

import { describe, expect, it } from "vitest";
import { ActivityKind, ActivityPhase } from "../../activity-types";
import {
	applyProgress,
	initialStatus,
	markFailed,
	markReady,
	markStarted,
} from "../search/embedder-status";
import { SEMANTIC_MODEL_OP_ID, operationFromSemanticStatus } from "./semantic-activity";

describe("operationFromSemanticStatus", () => {
	it("maps Downloading to a running op carrying the percent", () => {
		const status = applyProgress(markStarted(), {
			file: "model.onnx",
			fileIndex: 0,
			fileCount: 5,
			downloaded: 30,
			total: 120,
		});
		expect(operationFromSemanticStatus(status)).toEqual({
			id: SEMANTIC_MODEL_OP_ID,
			kind: ActivityKind.ModelDownload,
			phase: ActivityPhase.Running,
			percent: 25,
			detail: null,
		});
	});

	it("maps Failed to an Error op carrying the message", () => {
		const op = operationFromSemanticStatus(markFailed("offline"));
		expect(op?.phase).toBe(ActivityPhase.Error);
		expect(op?.detail).toBe("offline");
	});

	it("shows nothing for Idle / Ready (not in-flight)", () => {
		expect(operationFromSemanticStatus(initialStatus())).toBeNull();
		expect(operationFromSemanticStatus(markReady())).toBeNull();
	});
});

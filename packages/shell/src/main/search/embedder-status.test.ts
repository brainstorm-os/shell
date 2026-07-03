import { describe, expect, it } from "vitest";
import {
	EmbedderPhase,
	SEMANTIC_MODEL_NAME,
	absentStatus,
	applyProgress,
	initialStatus,
	markFailed,
	markReady,
	markStarted,
} from "./embedder-status";

const tick = (over: Partial<Parameters<typeof applyProgress>[1]> = {}) => ({
	file: "model.onnx",
	fileIndex: 0,
	fileCount: 5,
	downloaded: 50,
	total: 100,
	...over,
});

describe("embedder-status", () => {
	it("starts Idle with the pinned model name and no progress", () => {
		const s = initialStatus();
		expect(s.phase).toBe(EmbedderPhase.Idle);
		expect(s.model).toBe(SEMANTIC_MODEL_NAME);
		expect(s.percent).toBeNull();
	});

	it("absentStatus is a terminal lexical-only marker", () => {
		expect(absentStatus().phase).toBe(EmbedderPhase.Absent);
	});

	it("markStarted enters Downloading and clears prior error", () => {
		const s = markStarted();
		expect(s.phase).toBe(EmbedderPhase.Downloading);
		expect(s.error).toBeNull();
		expect(s.percent).toBeNull();
	});

	it("applyProgress computes a clamped rounded percent + 1-based file number", () => {
		const s = applyProgress(initialStatus(), tick({ downloaded: 50, total: 200, fileIndex: 1 }));
		expect(s.phase).toBe(EmbedderPhase.Downloading);
		expect(s.percent).toBe(25);
		expect(s.fileNumber).toBe(2);
		expect(s.fileCount).toBe(5);
		expect(s.file).toBe("model.onnx");
	});

	it("treats a zero/missing total as indeterminate (null percent)", () => {
		expect(applyProgress(initialStatus(), tick({ total: 0 })).percent).toBeNull();
	});

	it("clamps an over-100 tick (downloaded > total) to 100", () => {
		expect(applyProgress(initialStatus(), tick({ downloaded: 300, total: 200 })).percent).toBe(100);
	});

	it("clamps negative byte counts to 0", () => {
		const s = applyProgress(initialStatus(), tick({ downloaded: -5, total: 100 }));
		expect(s.downloadedBytes).toBe(0);
		expect(s.percent).toBe(0);
	});

	it("recovers the Downloading phase from a Failed status on a stray tick", () => {
		const s = applyProgress(markFailed("offline"), tick());
		expect(s.phase).toBe(EmbedderPhase.Downloading);
		expect(s.error).toBeNull();
	});

	it("markReady is terminal at 100%", () => {
		const s = markReady();
		expect(s.phase).toBe(EmbedderPhase.Ready);
		expect(s.percent).toBe(100);
	});

	it("markFailed carries a retryable error message", () => {
		const s = markFailed("network unreachable");
		expect(s.phase).toBe(EmbedderPhase.Failed);
		expect(s.error).toBe("network unreachable");
	});
});

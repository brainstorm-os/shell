// @vitest-environment jsdom
/**
 * 11.3 — `<SemanticStatusCard>` renders the on-device model's download /
 * readiness state in Settings → Search. Each phase maps to distinct copy (and
 * the Downloading phase to a `progressbar` with the byte percent), so a user
 * can tell the ~130 MB first-run download from "ready" from "unavailable".
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EmbedderPhase,
	SEMANTIC_MODEL_NAME,
	type SemanticModelStatus,
	absentStatus,
	applyProgress,
	initialStatus,
	markFailed,
	markReady,
} from "../../main/search/embedder-status";
import { SemanticStatusCard } from "./search-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SemanticStatusCard", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	const render = (status: SemanticModelStatus) => {
		act(() => root.render(<SemanticStatusCard status={status} />));
	};

	it("shows the model name and an idle hint before any download", () => {
		render(initialStatus());
		expect(host.querySelector(".search-index__semantic")?.getAttribute("data-phase")).toBe(
			EmbedderPhase.Idle,
		);
		expect(host.textContent).toContain(SEMANTIC_MODEL_NAME);
		expect(host.querySelector(".search-index__semantic-progress")).toBeNull();
	});

	it("renders the byte percent + a decorative bar while downloading", () => {
		const status = applyProgress(initialStatus(), {
			file: "model.onnx",
			fileIndex: 0,
			fileCount: 5,
			downloaded: 30,
			total: 120,
		});
		render(status);
		expect(host.querySelector(".search-index__semantic-progress")).not.toBeNull();
		expect(host.textContent).toContain("25%");
		// The bar is decorative — the percent text is the assistive-tech source.
		const bar = host.querySelector(".search-index__semantic .search-index__bar");
		expect(bar?.getAttribute("aria-hidden")).toBe("true");
		const fill = bar?.querySelector<HTMLElement>(".search-index__bar-fill");
		expect(fill?.style.width).toBe("25%");
	});

	it("shows an indeterminate bar (no fixed width) when there's no total", () => {
		const status = applyProgress(initialStatus(), {
			file: "model.onnx",
			fileIndex: 0,
			fileCount: 5,
			downloaded: 0,
			total: 0,
		});
		render(status);
		expect(host.querySelector(".search-index__semantic-progress")).not.toBeNull();
		const fill = host.querySelector<HTMLElement>(".search-index__bar-fill");
		// No inline width → CSS drives it full-width (indeterminate).
		expect(fill?.style.width).toBe("");
	});

	it("marks the ready phase (no progress bar)", () => {
		render(markReady());
		expect(host.querySelector(".search-index__semantic")?.getAttribute("data-phase")).toBe(
			EmbedderPhase.Ready,
		);
		expect(host.querySelector(".search-index__semantic-progress")).toBeNull();
	});

	it("surfaces the failure message on the failed phase", () => {
		render(markFailed("network unreachable"));
		expect(host.textContent).toContain("network unreachable");
	});

	it("reads as a quiet unavailable note when the addon is absent", () => {
		render(absentStatus());
		expect(host.querySelector(".search-index__semantic")?.getAttribute("data-phase")).toBe(
			EmbedderPhase.Absent,
		);
	});
});

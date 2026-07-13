/**
 * @vitest-environment jsdom
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsBetaNotice } from "./beta-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	window.localStorage.clear();
	window.brainstorm = {
		version: "0.4.2",
		platform: "darwin",
	} as typeof window.brainstorm;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	window.localStorage.clear();
});

function panel(): HTMLElement | null {
	return document.querySelector('[data-testid="analytics-beta-notice"]');
}

describe("<AnalyticsBetaNotice>", () => {
	it("shows once on beta builds and hides after dismiss", () => {
		act(() => root.render(<AnalyticsBetaNotice />));
		expect(panel()).not.toBeNull();

		const dismiss = document.querySelector<HTMLButtonElement>(
			'[data-testid="analytics-beta-notice-dismiss"]',
		);
		act(() => dismiss?.click());

		expect(window.localStorage.getItem("brainstorm.analytics.betaNoticeDismissed")).toBe(
			"beta-analytics-v1",
		);

		act(() => root.unmount());
		root = createRoot(container);
		act(() => root.render(<AnalyticsBetaNotice />));
		expect(panel()).toBeNull();
	});

	it("does not show on GA builds", () => {
		window.brainstorm = { version: "1.0.0", platform: "darwin" } as typeof window.brainstorm;
		act(() => root.render(<AnalyticsBetaNotice />));
		expect(panel()).toBeNull();
	});
});
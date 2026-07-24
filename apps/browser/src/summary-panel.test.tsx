// @vitest-environment jsdom
/**
 * Browser-8 — the summary panel's contract: it shows the page it summarized,
 * distinguishes the two waiting states, tells the user WHY a summary failed,
 * and never presents a generated summary without its provenance line.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryFailure, SummaryPhase } from "./logic/summarize";
import { SummaryPanel } from "./summary-panel";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

const noop = () => {};

async function render(props: Partial<Parameters<typeof SummaryPanel>[0]> = {}) {
	await act(async () => {
		root.render(
			<SummaryPanel
				phase={SummaryPhase.Ready}
				title="An article"
				summary="The gist."
				failure={null}
				onDismiss={noop}
				{...props}
			/>,
		);
	});
	return { container };
}

describe("SummaryPanel", () => {
	it("renders nothing when idle", async () => {
		const h = await render({ phase: SummaryPhase.Idle });
		expect(h.container.querySelector("[data-testid='browser-summary']")).toBeNull();
	});

	it("shows the summary with the page it came from", async () => {
		const h = await render();
		expect(h.container.querySelector("[data-testid='browser-summary-text']")?.textContent).toBe(
			"The gist.",
		);
		expect(h.container.querySelector(".browser__summary-source")?.textContent).toBe("An article");
	});

	it("always carries the provenance line with a ready summary", async () => {
		const h = await render();
		expect(h.container.querySelector(".browser__summary-note")?.textContent ?? "").not.toBe("");
	});

	it("distinguishes reading the page from waiting on the model", async () => {
		const reading = await render({ phase: SummaryPhase.Reading });
		const readingText = reading.container.querySelector(".browser__summary-body")?.textContent;
		const summarizing = await render({ phase: SummaryPhase.Summarizing });
		expect(summarizing.container.querySelector(".browser__summary-body")?.textContent).not.toBe(
			readingText,
		);
	});

	it("says WHY a summary failed, per reason", async () => {
		const noContent = await render({
			phase: SummaryPhase.Failed,
			failure: SummaryFailure.NoContent,
		});
		const noContentText = noContent.container.querySelector("[role='alert']")?.textContent ?? "";
		expect(noContentText).not.toBe("");

		const noModel = await render({ phase: SummaryPhase.Failed, failure: SummaryFailure.NoModel });
		expect(noModel.container.querySelector("[role='alert']")?.textContent).not.toBe(noContentText);
	});

	it("shows no summary text in the failed state (never a stale answer)", async () => {
		const h = await render({
			phase: SummaryPhase.Failed,
			failure: SummaryFailure.Failed,
			summary: "stale text",
		});
		expect(h.container.textContent).not.toContain("stale text");
	});

	it("dismisses", async () => {
		const onDismiss = vi.fn();
		const h = await render({ onDismiss });
		const button = h.container.querySelector<HTMLButtonElement>(
			"[data-testid='browser-summary-dismiss']",
		);
		await act(async () => button?.click());
		expect(onDismiss).toHaveBeenCalledOnce();
	});
});

// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureOutcome } from "../logic/capture-filing";
import { QuickCapture, type QuickCaptureResult } from "./quick-capture";

let root: Root | null = null;

function mount(onCapture: (raw: string) => Promise<QuickCaptureResult>, collectionCount = 1) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root?.render(<QuickCapture onCapture={onCapture} collectionCount={collectionCount} />));
	const input = host.querySelector<HTMLInputElement>('[data-testid="journal-capture-input"]');
	const form = host.querySelector<HTMLFormElement>('[data-testid="journal-capture"]');
	if (!input || !form) throw new Error("capture not rendered");
	return { host, input, form };
}

function type(input: HTMLInputElement, value: string) {
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("QuickCapture", () => {
	it("submits on Enter (native form submit), clears, and reports where it went", async () => {
		const onCapture = vi.fn(async () => ({
			outcome: CaptureOutcome.Filed,
			collectionName: "Reading list",
		}));
		const { host, input, form } = mount(onCapture);
		expect(input.placeholder).toContain("#collection");
		type(input, "Piranesi #reading-list");
		await act(async () => {
			form.requestSubmit();
		});
		expect(onCapture).toHaveBeenCalledWith("Piranesi #reading-list");
		expect(input.value).toBe("");
		expect(host.querySelector('[data-testid="journal-capture-status"]')?.textContent).toBe(
			"Filed in Reading list and linked from today",
		);
	});

	it("keeps the draft when the day could not take it", async () => {
		const onCapture = vi.fn(async () => ({
			outcome: CaptureOutcome.Unavailable,
			collectionName: null,
		}));
		const { input, form } = mount(onCapture, 0);
		type(input, "keep me");
		await act(async () => {
			form.requestSubmit();
		});
		expect(input.value).toBe("keep me");
	});

	it("ignores a blank submit", async () => {
		const onCapture = vi.fn();
		const { form } = mount(onCapture);
		await act(async () => {
			form.requestSubmit();
		});
		expect(onCapture).not.toHaveBeenCalled();
	});
});

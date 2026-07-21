// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EmbedderPhase,
	type SemanticModelStatus,
	initialStatus,
	markStarted,
	needsConsentStatus,
} from "../../main/search/embedder-status";
import { SemanticStatusCard } from "./search-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function enableButton(): HTMLButtonElement | null {
	return host.querySelector<HTMLButtonElement>("[data-testid='settings-search-enable-semantic']");
}

function render(status: SemanticModelStatus, onEnable?: () => void, enabling?: boolean) {
	act(() =>
		root.render(
			<SemanticStatusCard
				status={status}
				{...(onEnable ? { onEnable } : {})}
				{...(enabling !== undefined ? { enabling } : {})}
			/>,
		),
	);
}

describe("SemanticStatusCard — consent gate (11.3)", () => {
	it("offers an Enable button in the NeedsConsent phase", () => {
		const onEnable = vi.fn();
		render(needsConsentStatus(), onEnable);
		const button = enableButton();
		expect(button).not.toBeNull();
		act(() => button?.click());
		expect(onEnable).toHaveBeenCalledTimes(1);
	});

	it("disables the button while enabling is in flight", () => {
		render(needsConsentStatus(), vi.fn(), true);
		expect(enableButton()?.disabled).toBe(true);
	});

	it("shows no Enable button once the model is downloading or idle", () => {
		render(markStarted(), vi.fn());
		expect(enableButton()).toBeNull();
		render(initialStatus(), vi.fn());
		expect(enableButton()).toBeNull();
	});

	it("renders NeedsConsent inertly when no onEnable is wired (ambient card)", () => {
		render(needsConsentStatus());
		expect(enableButton()).toBeNull();
		expect(host.querySelector(".search-index__semantic")?.getAttribute("data-phase")).toBe(
			EmbedderPhase.NeedsConsent,
		);
	});
});

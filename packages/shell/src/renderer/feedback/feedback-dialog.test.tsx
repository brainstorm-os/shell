/**
 * @vitest-environment jsdom
 *
 * `<FeedbackDialog>` — Feedback-1 bug-report client.
 *
 * Asserts the form renders + validation surface + submit pipeline + the
 * sensitivity toggle hide/show + the log-preview opener. Bridge calls go
 * through the injected `submit` / `fetchSettings` / `fetchRecentLog`
 * test hooks; production wires `window.brainstorm.feedback.*`.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FeedbackKind,
	type FeedbackPayload,
	FeedbackSensitivity,
	type FeedbackSettings,
} from "../../feedback-wire-types";
import { FeedbackDialog } from "./feedback-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

async function flushPromises() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

function $(selector: string): HTMLElement | null {
	return container.ownerDocument.querySelector<HTMLElement>(selector);
}

function $$(selector: string): HTMLElement[] {
	return Array.from(container.ownerDocument.querySelectorAll<HTMLElement>(selector));
}

function changeInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	const proto =
		el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	setter?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

function makeEnabledSettings(overrides: Partial<FeedbackSettings> = {}): FeedbackSettings {
	return {
		enabled: true,
		endpoint: "https://admin.example/api/feedback",
		installationId: "01HFEEDBACKINSTALLATIONID0",
		crashReportingEnabled: false,
		lastCrashSubmitAttemptMs: null,
		...overrides,
	};
}

describe("<FeedbackDialog>", () => {
	it("renders the kind + sensitivity segmented controls", async () => {
		const fetchSettings = vi.fn().mockResolvedValue(makeEnabledSettings());
		act(() =>
			root.render(
				<FeedbackDialog
					onClose={() => undefined}
					submit={vi.fn()}
					fetchSettings={fetchSettings}
					fetchRecentLog={vi.fn().mockResolvedValue("")}
				/>,
			),
		);
		await flushPromises();
		expect($('[data-testid="feedback-kind-bug"]')).not.toBeNull();
		expect($('[data-testid="feedback-kind-idea"]')).not.toBeNull();
		expect($('[data-testid="feedback-kind-question"]')).not.toBeNull();
		expect($('[data-testid="feedback-kind-other"]')).not.toBeNull();
		expect($('[data-testid="feedback-sensitivity-anonymous"]')).not.toBeNull();
		expect($('[data-testid="feedback-sensitivity-identity-voluntary"]')).not.toBeNull();
	});

	it("disables submit while title or body is empty", async () => {
		act(() =>
			root.render(
				<FeedbackDialog
					onClose={() => undefined}
					submit={vi.fn()}
					fetchSettings={vi.fn().mockResolvedValue(makeEnabledSettings())}
					fetchRecentLog={vi.fn().mockResolvedValue("")}
				/>,
			),
		);
		await flushPromises();
		const submitBtn = $('[data-testid="feedback-submit"]') as HTMLButtonElement | null;
		expect(submitBtn).not.toBeNull();
		expect(submitBtn?.disabled).toBe(true);
	});

	it("enables submit when title + body are filled", async () => {
		act(() =>
			root.render(
				<FeedbackDialog
					onClose={() => undefined}
					submit={vi.fn()}
					fetchSettings={vi.fn().mockResolvedValue(makeEnabledSettings())}
					fetchRecentLog={vi.fn().mockResolvedValue("")}
				/>,
			),
		);
		await flushPromises();
		const title = $('[data-testid="feedback-title"]') as HTMLInputElement;
		const body = $('[data-testid="feedback-body"]') as HTMLTextAreaElement;
		act(() => {
			changeInput(title, "Crashed on save");
			changeInput(body, "Steps to reproduce…");
		});
		const submitBtn = $('[data-testid="feedback-submit"]') as HTMLButtonElement;
		expect(submitBtn.disabled).toBe(false);
	});

	it("sensitivity = IdentityVoluntary reveals the email input", async () => {
		act(() =>
			root.render(
				<FeedbackDialog
					onClose={() => undefined}
					submit={vi.fn()}
					fetchSettings={vi.fn().mockResolvedValue(makeEnabledSettings())}
					fetchRecentLog={vi.fn().mockResolvedValue("")}
				/>,
			),
		);
		await flushPromises();
		expect($('[data-testid="feedback-email"]')).toBeNull();
		const id = $('[data-testid="feedback-sensitivity-identity-voluntary"]') as HTMLButtonElement;
		act(() => id.click());
		expect($('[data-testid="feedback-email"]')).not.toBeNull();
	});

	it("recent-log toggle reveals the preview opener", async () => {
		act(() =>
			root.render(
				<FeedbackDialog
					onClose={() => undefined}
					submit={vi.fn()}
					fetchSettings={vi.fn().mockResolvedValue(makeEnabledSettings())}
					fetchRecentLog={vi.fn().mockResolvedValue("redacted line one\nline two")}
				/>,
			),
		);
		await flushPromises();
		expect($('[data-testid="feedback-log-toggle"]')).toBeNull();
		const check = $('[data-testid="feedback-include-log"]') as HTMLInputElement;
		act(() => {
			check.click();
		});
		await flushPromises();
		const toggle = $('[data-testid="feedback-log-toggle"]') as HTMLButtonElement | null;
		expect(toggle).not.toBeNull();
		act(() => toggle?.click());
		await flushPromises();
		expect($('[data-testid="feedback-log-preview"]')).not.toBeNull();
	});

	it("submit calls the injected submitter with the redacted-shaped payload", async () => {
		const submit = vi.fn().mockResolvedValue({ ok: true, requestId: "01H0000ABC" });
		act(() =>
			root.render(
				<FeedbackDialog
					onClose={() => undefined}
					submit={submit}
					fetchSettings={vi.fn().mockResolvedValue(makeEnabledSettings())}
					fetchRecentLog={vi.fn().mockResolvedValue("")}
					clientVersion="abc1234"
					clientPlatform="darwin"
					now={() => 1_700_000_000_000}
					newRequestId={() => "01H0000ABCDEFGHJKMNPQRSTV0"}
				/>,
			),
		);
		await flushPromises();
		const title = $('[data-testid="feedback-title"]') as HTMLInputElement;
		const body = $('[data-testid="feedback-body"]') as HTMLTextAreaElement;
		act(() => {
			changeInput(title, "Crashed on save");
			changeInput(body, "Steps to reproduce…");
		});
		const form = $('[data-testid="feedback-form"]') as HTMLFormElement;
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flushPromises();
		expect(submit).toHaveBeenCalledTimes(1);
		const payload = submit.mock.calls[0]?.[0] as FeedbackPayload | undefined;
		expect(payload?.kind).toBe(FeedbackKind.Bug);
		expect(payload?.title).toBe("Crashed on save");
		expect(payload?.body).toBe("Steps to reproduce…");
		expect(payload?.sensitivity).toBe(FeedbackSensitivity.Anonymous);
		expect(payload?.clientVersion).toBe("abc1234");
		expect(payload?.requestId).toBe("01H0000ABCDEFGHJKMNPQRSTV0");
	});

	it("renders the opt-in banner when feedback is off", async () => {
		act(() =>
			root.render(
				<FeedbackDialog
					onClose={() => undefined}
					submit={vi.fn()}
					fetchSettings={vi.fn().mockResolvedValue(makeEnabledSettings({ enabled: false }))}
					fetchRecentLog={vi.fn().mockResolvedValue("")}
				/>,
			),
		);
		await flushPromises();
		const submitBtn = $('[data-testid="feedback-submit"]') as HTMLButtonElement;
		expect(submitBtn.disabled).toBe(true);
		const banners = $$(".feedback-dialog__banner");
		expect(banners.length).toBeGreaterThan(0);
	});

	it("banner Enable button flips the opt-in in place — no Settings round-trip", async () => {
		const updateSettings = vi.fn().mockResolvedValue(makeEnabledSettings({ enabled: true }));
		act(() =>
			root.render(
				<FeedbackDialog
					onClose={() => undefined}
					submit={vi.fn()}
					fetchSettings={vi.fn().mockResolvedValue(makeEnabledSettings({ enabled: false }))}
					updateSettings={updateSettings}
					fetchRecentLog={vi.fn().mockResolvedValue("")}
				/>,
			),
		);
		await flushPromises();
		const enableBtn = $('[data-testid="feedback-enable"]') as HTMLButtonElement;
		expect(enableBtn).not.toBeNull();
		act(() => enableBtn.click());
		await flushPromises();
		expect(updateSettings).toHaveBeenCalledWith({ enabled: true });
		expect($('[data-testid="feedback-enable"]')).toBeNull();
		const title = $('[data-testid="feedback-title"]') as HTMLInputElement;
		const body = $('[data-testid="feedback-body"]') as HTMLTextAreaElement;
		act(() => {
			changeInput(title, "A title");
			changeInput(body, "A body");
		});
		const submitBtn = $('[data-testid="feedback-submit"]') as HTMLButtonElement;
		expect(submitBtn.disabled).toBe(false);
	});

	it("renders the endpoint-missing banner when endpoint is null", async () => {
		act(() =>
			root.render(
				<FeedbackDialog
					onClose={() => undefined}
					submit={vi.fn()}
					fetchSettings={vi.fn().mockResolvedValue(makeEnabledSettings({ endpoint: null }))}
					fetchRecentLog={vi.fn().mockResolvedValue("")}
				/>,
			),
		);
		await flushPromises();
		const submitBtn = $('[data-testid="feedback-submit"]') as HTMLButtonElement;
		expect(submitBtn.disabled).toBe(true);
	});

	it("surfaces a submission error inline", async () => {
		const submit = vi.fn().mockRejectedValue(new Error("rejected: server said no"));
		act(() =>
			root.render(
				<FeedbackDialog
					onClose={() => undefined}
					submit={submit}
					fetchSettings={vi.fn().mockResolvedValue(makeEnabledSettings())}
					fetchRecentLog={vi.fn().mockResolvedValue("")}
				/>,
			),
		);
		await flushPromises();
		act(() => {
			changeInput($('[data-testid="feedback-title"]') as HTMLInputElement, "x");
			changeInput($('[data-testid="feedback-body"]') as HTMLTextAreaElement, "y");
		});
		const form = $('[data-testid="feedback-form"]') as HTMLFormElement;
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flushPromises();
		expect($('[data-testid="feedback-error"]')).not.toBeNull();
	});

	it("surfaces success state with the request id", async () => {
		const submit = vi.fn().mockResolvedValue({ ok: true, requestId: "01HMYREQUEST123" });
		act(() =>
			root.render(
				<FeedbackDialog
					onClose={() => undefined}
					submit={submit}
					fetchSettings={vi.fn().mockResolvedValue(makeEnabledSettings())}
					fetchRecentLog={vi.fn().mockResolvedValue("")}
				/>,
			),
		);
		await flushPromises();
		act(() => {
			changeInput($('[data-testid="feedback-title"]') as HTMLInputElement, "x");
			changeInput($('[data-testid="feedback-body"]') as HTMLTextAreaElement, "y");
		});
		const form = $('[data-testid="feedback-form"]') as HTMLFormElement;
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flushPromises();
		const success = $('[data-testid="feedback-success"]');
		expect(success).not.toBeNull();
		expect(success?.textContent).toContain("01HMYREQUEST123");
	});

	it("Cancel calls onClose", async () => {
		const onClose = vi.fn();
		act(() =>
			root.render(
				<FeedbackDialog
					onClose={onClose}
					submit={vi.fn()}
					fetchSettings={vi.fn().mockResolvedValue(makeEnabledSettings())}
					fetchRecentLog={vi.fn().mockResolvedValue("")}
				/>,
			),
		);
		await flushPromises();
		const cancel = $('[data-testid="feedback-cancel"]') as HTMLButtonElement;
		act(() => cancel.click());
		expect(onClose).toHaveBeenCalled();
	});
});

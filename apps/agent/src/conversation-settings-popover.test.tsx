// @vitest-environment jsdom
/**
 * Agent-14 — the conversation settings popover's model field: custom endpoints
 * from `ai.providers()` appear by name when the app holds `ai.provider:*`, the
 * placeholder names the provider's default model, typing a sane id persists it
 * (trimmed), and a control-character id is flagged and never persisted.
 */

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ConversationSettings,
	ConversationSettingsPopover,
} from "./conversation-settings-popover";
import { type RenderHandle, renderInto } from "./test/render";

const CAPS = ["ai.use", "ai.provider:ollama", "ai.provider:*"];
const PROVIDERS = [
	{ id: "ollama", label: "Ollama", defaultModel: "llama3.2", models: ["llama3.2"], custom: false },
	{
		id: "custom-0123abcd",
		label: "Studio box",
		defaultModel: "qwen3",
		models: ["qwen3"],
		custom: true,
	},
];

const settings = (over: Partial<ConversationSettings> = {}): ConversationSettings => ({
	grants: CAPS,
	provider: "custom-0123abcd",
	model: undefined,
	tokenBudget: undefined,
	tokensSpent: 0,
	...over,
});

function typeInto(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

let handle: RenderHandle | null = null;
afterEach(async () => {
	await handle?.unmount();
	handle = null;
});

async function mount(onModelChange = vi.fn(), over: Partial<ConversationSettings> = {}) {
	handle = await renderInto(
		<ConversationSettingsPopover
			appCaps={CAPS}
			providers={PROVIDERS}
			settings={settings(over)}
			onClose={() => {}}
			onGrantsChange={() => {}}
			onProviderChange={() => {}}
			onModelChange={onModelChange}
			onBudgetChange={() => {}}
		/>,
	);
	const model = document.querySelector<HTMLInputElement>('[data-testid="agent-settings-model"]');
	if (!model) throw new Error("model field missing");
	return { model, onModelChange };
}

describe("ConversationSettingsPopover — model field", () => {
	it("shows the pinned custom endpoint by name and its default model as the placeholder", async () => {
		const { model } = await mount();
		const provider = document.querySelector('[data-testid="agent-settings-provider"]');
		expect(provider?.textContent).toContain("Studio box");
		expect(model.placeholder).toContain("qwen3");
		expect(document.querySelector('[data-testid="agent-settings-model-suggestions"]')).not.toBeNull();
	});

	it("persists a typed model id trimmed, and clears on empty", async () => {
		const { model, onModelChange } = await mount();
		await act(async () => typeInto(model, " qwen3-coder "));
		expect(onModelChange).toHaveBeenLastCalledWith("qwen3-coder");
		await act(async () => typeInto(model, ""));
		expect(onModelChange).toHaveBeenLastCalledWith(undefined);
	});

	it("flags a control-character id and does not persist it", async () => {
		const { model, onModelChange } = await mount();
		await act(async () => typeInto(model, "bad\u0007id"));
		expect(onModelChange).not.toHaveBeenCalled();
		expect(model.getAttribute("aria-invalid")).toBe("true");
		expect(document.querySelector('[role="alert"]')).not.toBeNull();
	});
});

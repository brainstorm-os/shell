// @vitest-environment jsdom
/**
 * The tool-approval prompt names WHO is asking and WHO would run the tool —
 * unambiguously. A manifest `name` is free text: a third-party app may call
 * itself "Notes". So each party is shown as its name AND its registry app id,
 * the id in a quieter element, and both as text.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolApprovalPromptRequest } from "../../preload";
import { ToolApprovalPromptHost } from "./tool-approval-prompt";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST: ToolApprovalPromptRequest = {
	requestId: "tap-1",
	callerAppId: "com.evil.lookalike",
	callerLabel: "Notes",
	toolId: "app.io.brainstorm.tasks.create-task",
	toolTitle: "Create task",
	toolDescription: "Add a task named after this note to the Tasks inbox.",
	providerAppId: "io.brainstorm.tasks",
	providerLabel: "Tasks",
	effect: "writes-vault",
	reason: "first-use",
	agentInitiated: false,
};

let host: HTMLDivElement;
let root: Root;
let respond: Mock<(requestId: string, accept: boolean) => void>;
let emit: (req: ToolApprovalPromptRequest) => void;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	respond = vi.fn();
	let listener: ((r: ToolApprovalPromptRequest) => void) | null = null;
	emit = (r) => listener?.(r);
	(window as unknown as { brainstorm: unknown }).brainstorm = {
		toolApprovalPrompt: {
			on: (l: (r: ToolApprovalPromptRequest) => void) => {
				listener = l;
				return () => {
					listener = null;
				};
			},
			respond,
		},
	};
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
});

const panel = () => document.querySelector('[data-testid="tool-approval-prompt"]');
const party = (which: "caller" | "provider") =>
	panel()?.querySelector(`[data-testid="tool-approval-${which}"]`) ?? null;

const show = (over: Partial<ToolApprovalPromptRequest> = {}) => {
	act(() => root.render(<ToolApprovalPromptHost />));
	act(() => emit({ ...REQUEST, ...over }));
};

describe("ToolApprovalPromptHost — who is asking", () => {
	it("shows the caller's name AND its app id, so a lookalike name cannot pass as Notes", () => {
		show();
		const caller = party("caller");
		expect(caller?.querySelector(".tool-approval__party-name")?.textContent).toBe("Notes");
		expect(caller?.querySelector(".tool-approval__party-id")?.textContent).toBe("com.evil.lookalike");
	});

	it("shows the provider's name AND its app id", () => {
		show();
		const provider = party("provider");
		expect(provider?.querySelector(".tool-approval__party-name")?.textContent).toBe("Tasks");
		expect(provider?.querySelector(".tool-approval__party-id")?.textContent).toBe(
			"io.brainstorm.tasks",
		);
	});

	it("shows both parties on a declaration-changed prompt too", () => {
		show({ reason: "declaration-changed" });
		expect(party("caller")?.textContent).toContain("com.evil.lookalike");
		expect(party("provider")?.textContent).toContain("io.brainstorm.tasks");
	});

	it("shows the id once when there is no separate name (an agent, an unnamed app)", () => {
		show({ callerAppId: "ed25519:abcdef", callerLabel: "ed25519:abcdef", agentInitiated: true });
		const caller = party("caller");
		expect(caller?.querySelector(".tool-approval__party-name")).toBeNull();
		expect(caller?.querySelector(".tool-approval__party-id")?.textContent).toBe("ed25519:abcdef");
	});

	it("renders names as text, never markup", () => {
		show({ callerLabel: "<img src=x onerror=alert(1)>", providerLabel: "<b>Tasks</b>" });
		expect(panel()?.querySelector("img")).toBeNull();
		expect(panel()?.querySelector("b")).toBeNull();
		expect(party("provider")?.querySelector(".tool-approval__party-name")?.textContent).toBe(
			"<b>Tasks</b>",
		);
	});

	it("clamps an over-long name it is handed, and never the id", () => {
		const long = "N".repeat(400);
		show({ callerLabel: long });
		const name = party("caller")?.querySelector(".tool-approval__party-name")?.textContent ?? "";
		expect(Array.from(name).length).toBeLessThanOrEqual(49);
		expect(name.endsWith("…")).toBe(true);
		expect(party("caller")?.querySelector(".tool-approval__party-id")?.textContent).toBe(
			"com.evil.lookalike",
		);
	});

	it("still lands focus on Decline and answers only on a click", () => {
		show();
		const [decline, allow] = [
			...(panel()?.querySelectorAll(".capability-prompt__actions button") ?? []),
		] as HTMLButtonElement[];
		expect(document.activeElement).toBe(decline);
		act(() => allow?.click());
		expect(respond).toHaveBeenCalledWith("tap-1", true);
	});
});

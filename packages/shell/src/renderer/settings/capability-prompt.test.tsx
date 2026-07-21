// @vitest-environment jsdom
/**
 * KBN-S-cap-prompt — the capability-grant modal's keyboard contract. This is a
 * SECURITY surface, so the contract must fail safe:
 *   - initial focus lands on the safe **Deny** action (not the header ✕, not
 *     the destructive Allow), so the default a keyboard/SR user activates denies;
 *   - there is NO global Enter-grants shortcut (a stray Enter must never grant);
 *   - Escape / backdrop / close all route through `onClose` → deny;
 *   - granting requires deliberately focusing + activating Allow.
 * The focus trap + opener-restore themselves are covered by the shared
 * `<Popover>` + `useFocusTrap` tests; here we pin the deny-by-default contract.
 */

import { getEscapeStack, installEscapeHandler } from "@brainstorm-os/sdk/a11y";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityPromptRequest } from "../../preload";
import { CapabilityPromptHost } from "./capability-prompt";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST: CapabilityPromptRequest = {
	requestId: "req-1",
	appId: "io.brainstorm.demo",
	capability: "network.fetch",
	reason: "Fetch link previews",
};

let host: HTMLDivElement;
let root: Root;
let respond: Mock<(requestId: string, accept: boolean) => void>;
let emit: (req: CapabilityPromptRequest) => void;
let uninstallEscape: () => void;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	respond = vi.fn();
	let listener: ((r: CapabilityPromptRequest) => void) | null = null;
	emit = (r) => listener?.(r);
	(window as unknown as { brainstorm: unknown }).brainstorm = {
		capabilityPrompt: {
			on: (l: (r: CapabilityPromptRequest) => void) => {
				listener = l;
				return () => {
					listener = null;
				};
			},
			respond,
		},
	};
	// The document-level Escape drain is installed by the dashboard at startup;
	// a component test wires it explicitly so Escape behaves as in production.
	uninstallEscape = installEscapeHandler(getEscapeStack());
});

afterEach(() => {
	act(() => root.unmount());
	uninstallEscape();
	host.remove();
	(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
});

const panel = () => document.querySelector('[data-testid="capability-prompt"]');
const actionButtons = () =>
	[
		...(panel()?.querySelectorAll(".capability-prompt__actions button") ?? []),
	] as HTMLButtonElement[];

const show = () => {
	act(() => root.render(<CapabilityPromptHost />));
	act(() => emit(REQUEST));
};

describe("CapabilityPromptHost (KBN-S-cap-prompt)", () => {
	it("lands initial focus on the safe Deny action", () => {
		show();
		const [deny] = actionButtons();
		expect(deny).toBeTruthy();
		expect(document.activeElement).toBe(deny);
	});

	it("a stray Enter never grants the capability (no global confirm shortcut)", () => {
		show();
		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
			);
		});
		expect(respond).not.toHaveBeenCalledWith("req-1", true);
	});

	it("Escape denies, never grants", () => {
		show();
		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		expect(respond).toHaveBeenCalledWith("req-1", false);
		expect(respond).not.toHaveBeenCalledWith("req-1", true);
	});

	it("clicking Allow grants only on deliberate activation", () => {
		show();
		const allow = actionButtons()[1];
		act(() => allow?.click());
		expect(respond).toHaveBeenCalledWith("req-1", true);
	});

	it("clicking Deny denies", () => {
		show();
		const deny = actionButtons()[0];
		act(() => deny?.click());
		expect(respond).toHaveBeenCalledWith("req-1", false);
	});
});

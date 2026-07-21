// @vitest-environment jsdom
/**
 * KBN-G-roles — `<OpenWithPromptHost>` radiogroup keyboard contract.
 *
 * The roving/typeahead/role machinery lives in the SDK `useCompositeKeyboard`
 * tests; this file pins the wiring that lives in `open-with-prompt.tsx`: the
 * candidate list is a `radiogroup` of `radio`s whose checked state follows the
 * active index, ArrowDown moves the selection, and Enter on the active row
 * confirms via the bridge with the chosen app + remember flag.
 */

import {
	type OpenWithCandidate,
	type OpenWithDecision,
	OpenWithDecisionKind,
} from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenWithPromptHost } from "./open-with-prompt";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CANDIDATES: readonly OpenWithCandidate[] = [
	{ appId: "app.a", label: "App A", kind: "primary" },
	{ appId: "app.b", label: "App B", kind: "secondary" },
	{ appId: "app.c", label: "App C", kind: "secondary" },
];

function dispatchKey(target: EventTarget, key: string): void {
	act(() => {
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	});
}

describe("OpenWithPromptHost — KBN-G-roles radiogroup", () => {
	let host: HTMLDivElement;
	let root: Root;
	let respond: Mock<(id: string, d: OpenWithDecision) => void>;
	let emit: (req: unknown) => void;

	beforeEach(() => {
		respond = vi.fn();
		let cb: ((req: unknown) => void) | null = null;
		emit = (req) => act(() => cb?.(req));
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			openWithPrompt: {
				on: (handler: (req: unknown) => void) => {
					cb = handler;
					return () => {
						cb = null;
					};
				},
				respond,
			},
		};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		act(() => root.render(<OpenWithPromptHost />));
		emit({ requestId: "r1", signature: "scheme:https", uri: "https://x", candidates: CANDIDATES });
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
	});

	// The shared <Popover> portals to document.body, so query the document.
	const group = () => document.querySelector('[role="radiogroup"]') as HTMLElement;
	const radios = () => [...document.querySelectorAll('[role="radio"]')] as HTMLElement[];

	it("renders a radiogroup of radios, first checked", () => {
		expect(group()).not.toBeNull();
		const r = radios();
		expect(r).toHaveLength(3);
		expect(r[0]?.getAttribute("aria-checked")).toBe("true");
		expect(r[1]?.getAttribute("aria-checked")).toBe("false");
	});

	it("ArrowDown moves the checked radio to the next candidate", () => {
		dispatchKey(group(), "ArrowDown");
		const r = radios();
		expect(r[0]?.getAttribute("aria-checked")).toBe("false");
		expect(r[1]?.getAttribute("aria-checked")).toBe("true");
	});

	it("Enter confirms the active candidate via the bridge", () => {
		dispatchKey(group(), "ArrowDown");
		dispatchKey(group(), "Enter");
		expect(respond).toHaveBeenCalledTimes(1);
		expect(respond).toHaveBeenCalledWith("r1", {
			kind: OpenWithDecisionKind.Pick,
			appId: "app.b",
			remember: false,
		});
	});

	it("clicking a row selects it without confirming", () => {
		act(() => radios()[2]?.click());
		expect(respond).not.toHaveBeenCalled();
		expect(radios()[2]?.getAttribute("aria-checked")).toBe("true");
	});
});

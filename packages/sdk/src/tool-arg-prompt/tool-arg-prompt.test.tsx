// @vitest-environment jsdom
/**
 * Tool-8b — the argument prompt component + host hook.
 *
 * The contracts pinned here: the declared inputs render through the shared
 * faces; submit hands over ONLY a bag that already passed the broker's
 * validator (a wrong/missing input renders a NAMED field error and the form
 * stays open — never a doomed call); cancel resolves `null` so the surface
 * makes no call and reports nothing; a superseding request cancels its
 * predecessor instead of hanging it.
 */

import {
	AppToolEffect,
	type AppToolInput,
	type AppToolRecord,
	AppToolSurface,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToolArgumentPrompt } from "./tool-arg-prompt";

const t = (key: string) => key;

const inputDef = (over: Partial<AppToolInput> & { name: string }): AppToolInput => ({
	description: "an argument",
	required: false,
	valueType: ValueType.Text,
	...over,
});

function tool(inputs: AppToolInput[], over: Partial<AppToolRecord> = {}): AppToolRecord {
	return {
		id: "app.io.example.p.rewrite",
		appId: "io.example.p",
		name: "rewrite",
		title: "Rewrite",
		description: "rewrites the text",
		effect: AppToolEffect.Pure,
		appliesTo: [],
		surfaces: [AppToolSurface.Menu],
		input: inputs,
		registeredAt: 1,
		appLabel: "Provider",
		...over,
	};
}

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

let promptFor: ReturnType<typeof useToolArgumentPrompt>["promptForToolArgs"];

function Harness() {
	const { promptForToolArgs, prompt } = useToolArgumentPrompt(t);
	promptFor = promptForToolArgs;
	return <>{prompt}</>;
}

function mount() {
	act(() => {
		root.render(<Harness />);
	});
}

const setValue = (testId: string, value: string) => {
	const el = container.querySelector<HTMLInputElement>(`[data-testid='${testId}']`);
	if (!el) throw new Error(`no input ${testId}`);
	act(() => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
};

const click = (selector: string) => {
	const el = container.querySelector<HTMLElement>(selector);
	if (!el) throw new Error(`no element ${selector}`);
	act(() => {
		el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
};

describe("useToolArgumentPrompt / ToolArgumentPrompt", () => {
	it("renders the declared inputs with the screened title and provider", async () => {
		mount();
		let settled = false;
		act(() => {
			void promptFor(
				tool([
					inputDef({ name: "text", required: true }),
					inputDef({ name: "level", valueType: ValueType.Number }),
					inputDef({ name: "loud", valueType: ValueType.Boolean }),
					inputDef({ name: "tone", choices: ["formal", "casual"] }),
				]),
			).then(() => {
				settled = true;
			});
		});
		expect(container.querySelector("[data-testid='tool-arg-prompt']")).not.toBeNull();
		expect(container.textContent).toContain("Rewrite — Provider");
		expect(container.textContent).toContain("rewrites the text");
		expect(container.querySelector("[data-testid='tool-arg-text']")).not.toBeNull();
		expect(container.querySelector("[data-testid='tool-arg-level']")).not.toBeNull();
		expect(container.querySelector("[data-testid='tool-arg-loud']")).not.toBeNull();
		// The choice set renders as the shared select trigger, never a native <select>.
		expect(container.querySelector("[data-testid='tool-arg-tone']")?.className).toContain(
			"bs-select",
		);
		expect(settled).toBe(false);
	});

	it("submit resolves the broker-validated bag", async () => {
		mount();
		let resolved: Readonly<Record<string, unknown>> | null | undefined;
		let request: Promise<unknown> = Promise.resolve();
		act(() => {
			request = promptFor(
				tool([
					inputDef({ name: "text", required: true }),
					inputDef({ name: "level", valueType: ValueType.Number }),
				]),
			).then((args) => {
				resolved = args;
			});
		});
		setValue("tool-arg-text", "hello");
		setValue("tool-arg-level", "3");
		click("[data-testid='tool-arg-run']");
		await act(async () => {
			await request;
		});
		expect(resolved).toEqual({ text: "hello", level: 3 });
		expect(Object.getPrototypeOf(resolved)).toBeNull();
		// The prompt closes once settled.
		expect(container.querySelector("[data-testid='tool-arg-prompt']")).toBeNull();
	});

	it("a missing required input renders a NAMED error and the form stays open", async () => {
		mount();
		const settled = vi.fn();
		act(() => {
			void promptFor(tool([inputDef({ name: "text", required: true })])).then(settled);
		});
		click("[data-testid='tool-arg-run']");
		await act(async () => {});
		expect(container.textContent).toContain("tool.args.error.required");
		expect(container.querySelector("[data-testid='tool-arg-prompt']")).not.toBeNull();
		expect(settled).not.toHaveBeenCalled();
	});

	it("an unparsable number renders its NAMED error", async () => {
		mount();
		act(() => {
			void promptFor(tool([inputDef({ name: "level", required: true, valueType: ValueType.Number })]));
		});
		setValue("tool-arg-level", "seven");
		click("[data-testid='tool-arg-run']");
		await act(async () => {});
		expect(container.textContent).toContain("tool.args.error.notANumber");
	});

	it("a date input shows a live preview and produces a DateValue", async () => {
		mount();
		let resolved: Readonly<Record<string, unknown>> | null | undefined;
		let request: Promise<unknown> = Promise.resolve();
		act(() => {
			request = promptFor(
				tool([inputDef({ name: "when", required: true, valueType: ValueType.Date })]),
			).then((args) => {
				resolved = args;
			});
		});
		setValue("tool-arg-when", "2026-08-02");
		expect(
			container.querySelector("[data-testid='tool-arg-when-preview']")?.textContent,
		).not.toContain("tool.args.error");
		click("[data-testid='tool-arg-run']");
		await act(async () => {
			await request;
		});
		expect(resolved?.when).toMatchObject({ granularity: "date" });
	});

	it("cancel resolves null — no call, no report", async () => {
		mount();
		let resolved: unknown = "unset";
		let request: Promise<unknown> = Promise.resolve();
		act(() => {
			request = promptFor(tool([inputDef({ name: "text", required: true })])).then((args) => {
				resolved = args;
			});
		});
		click("[data-testid='tool-arg-cancel']");
		await act(async () => {
			await request;
		});
		expect(resolved).toBeNull();
		expect(container.querySelector("[data-testid='tool-arg-prompt']")).toBeNull();
	});

	it("prefills the target into a compatible entityRef input", () => {
		mount();
		act(() => {
			void promptFor(
				tool([inputDef({ name: "note", required: true, valueType: ValueType.EntityRef })]),
				{ target: { entityId: "e42", entityType: "brainstorm/Note/v1" } },
			);
		});
		expect(container.querySelector<HTMLInputElement>("[data-testid='tool-arg-note']")?.value).toBe(
			"e42",
		);
	});

	it("a superseding request cancels its predecessor instead of hanging it", async () => {
		mount();
		let first: unknown = "unset";
		let firstRequest: Promise<unknown> = Promise.resolve();
		act(() => {
			firstRequest = promptFor(tool([inputDef({ name: "text", required: true })])).then((args) => {
				first = args;
			});
		});
		act(() => {
			void promptFor(tool([inputDef({ name: "other", required: true })]));
		});
		await act(async () => {
			await firstRequest;
		});
		expect(first).toBeNull();
		expect(container.querySelector("[data-testid='tool-arg-other']")).not.toBeNull();
	});
});

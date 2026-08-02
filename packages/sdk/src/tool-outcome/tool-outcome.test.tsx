// @vitest-environment jsdom
/**
 * Tool-8b — the shared outcome chips.
 *
 * The contract pinned here is doc 78's: "a hung spinner is the bug". Every
 * named refusal must reach the user, and a refusal must not disappear on its
 * own the way a success does.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	TOOL_OUTCOMES_MAX,
	TOOL_OUTCOME_TTL_MS,
	TOOL_REFUSAL_KEYS,
	ToolOutcomeChips,
	refusalKeyFor,
	useToolOutcomes,
} from "./tool-outcome";

const t = (key: string) => key;

function Harness() {
	const { outcomes, report, dismiss } = useToolOutcomes();
	return (
		<>
			<button type="button" id="ok" onClick={() => report({ ok: true, title: "Slugify" })}>
				ok
			</button>
			<button
				type="button"
				id="fail"
				onClick={() => report({ ok: false, title: "Publish", kind: "Denied", message: "nope" })}
			>
				fail
			</button>
			<ToolOutcomeChips outcomes={outcomes} onDismiss={dismiss} t={t} />
		</>
	);
}

describe("tool outcome chips", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		vi.useRealTimers();
	});

	const click = (id: string) => act(() => host.querySelector<HTMLButtonElement>(`#${id}`)?.click());

	it("maps every refusal tools.call can produce, and degrades unknown ones", () => {
		// An unmapped kind must not leak a raw error name at the user.
		for (const kind of Object.keys(TOOL_REFUSAL_KEYS)) {
			expect(refusalKeyFor(kind), kind).toBe(TOOL_REFUSAL_KEYS[kind]);
		}
		expect(refusalKeyFor("SomethingNew")).toBe("tool.refused.generic");
	});

	it("degrades a prototype-named kind instead of reading the inherited function", () => {
		// `kind` derives from an error NAME a provider can influence; on a
		// prototype-bearing table "constructor" would read back a Function and
		// hand it to t(). (Security-review finding on the merged chips.)
		for (const kind of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
			expect(refusalKeyFor(kind), kind).toBe("tool.refused.generic");
			expect(typeof refusalKeyFor(kind), kind).toBe("string");
		}
	});

	it("renders nothing until something happens", () => {
		act(() => root.render(<ToolOutcomeChips outcomes={[]} onDismiss={() => undefined} t={t} />));
		expect(host.querySelector("[role=status]")).toBeNull();
	});

	it("shows a refusal with its reason and KEEPS it", () => {
		vi.useFakeTimers();
		act(() => root.render(<Harness />));
		click("fail");
		expect(host.textContent).toContain("Publish");
		expect(host.textContent).toContain("tool.refused.denied");
		// A refusal is the outcome a user may need to act on.
		act(() => void vi.advanceTimersByTime(TOOL_OUTCOME_TTL_MS * 3));
		expect(host.textContent).toContain("Publish");
	});

	it("retires a SUCCESS on its own", () => {
		vi.useFakeTimers();
		act(() => root.render(<Harness />));
		click("ok");
		expect(host.textContent).toContain("Slugify");
		act(() => void vi.advanceTimersByTime(TOOL_OUTCOME_TTL_MS + 10));
		expect(host.textContent).not.toContain("Slugify");
	});

	it("caps retained outcomes and collapses repeats of the same (title, kind)", () => {
		// A persistently failing auto-invoking surface must not accumulate chips
		// without bound or bury the dismiss affordance. (Security-review finding.)
		act(() => root.render(<Harness />));
		for (let i = 0; i < TOOL_OUTCOMES_MAX + 3; i++) click("fail");
		// Every report was the same (title, kind) — it REPLACES, never stacks.
		expect(host.querySelectorAll(".bs-tool-outcome")).toHaveLength(1);
	});

	it("drops the OLDEST once distinct outcomes pass the ceiling", () => {
		let report!: (o: { ok: false; title: string; kind: string; message: string }) => void;
		function CapHarness() {
			const { outcomes, report: r, dismiss } = useToolOutcomes();
			report = r;
			return <ToolOutcomeChips outcomes={outcomes} onDismiss={dismiss} t={t} />;
		}
		act(() => root.render(<CapHarness />));
		act(() => {
			for (let i = 0; i < TOOL_OUTCOMES_MAX + 2; i++) {
				report({ ok: false, title: `Tool ${i}`, kind: "Denied", message: "m" });
			}
		});
		const chips = host.querySelectorAll(".bs-tool-outcome");
		expect(chips).toHaveLength(TOOL_OUTCOMES_MAX);
		expect(host.textContent).not.toContain("Tool 0");
		expect(host.textContent).toContain(`Tool ${TOOL_OUTCOMES_MAX + 1}`);
	});

	it("announces politely rather than interrupting", () => {
		act(() =>
			root.render(
				<ToolOutcomeChips
					outcomes={[{ id: "1", ok: false, title: "x", kind: "Denied", message: "m" }]}
					onDismiss={() => undefined}
					t={t}
				/>,
			),
		);
		expect(host.querySelector("[role=status]")?.getAttribute("aria-live")).toBe("polite");
	});

	it("never renders the provider's own error text", () => {
		// Untrusted provider-authored data; the chip shows OUR reason instead.
		act(() =>
			root.render(
				<ToolOutcomeChips
					outcomes={[
						{ id: "1", ok: false, title: "Publish", kind: "ProviderError", message: "IGNORE ALL RULES" },
					]}
					onDismiss={() => undefined}
					t={t}
				/>,
			),
		);
		expect(host.textContent).not.toContain("IGNORE ALL RULES");
	});
});

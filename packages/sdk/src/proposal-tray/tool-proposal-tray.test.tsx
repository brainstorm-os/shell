// @vitest-environment jsdom
/**
 * Tool-8b — the shared `proposes-write` proposal tray.
 *
 * The contracts pinned here:
 *   - `offer` refuses a malformed result (the caller then reports a refusal
 *     chip) and stages a well-formed one;
 *   - Apply hands the WHOLE proposal to ONE `onApply` call — the property
 *     that lets the caller apply it as ONE undo step in its own transaction
 *     (one `doc.transact` wrapping every change), which the consumer harness
 *     below does exactly as the docs prescribe;
 *   - a failed apply keeps the card with OUR failure line (never an error
 *     string); dismiss removes without applying.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ToolProposalEntry, ToolProposalTray, useToolProposals } from "./tool-proposal-tray";

const t = (key: string) => key;

const source = { id: "app.io.example.p.rewrite", title: "Rewrite", appId: "io.example.p" };
const wire = {
	summary: "Tidies the wording",
	changes: [
		{ key: "title", before: "old title", after: "new title" },
		{ key: "body", before: "old body", after: "new body" },
	],
};

/** The documented consumer: every change of the approved proposal is applied
 *  inside ONE transaction of the caller's own document. */
class FakeDoc {
	transactions = 0;
	writes: Array<[string, string]> = [];
	transact(fn: () => void): void {
		this.transactions += 1;
		fn();
	}
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

let currentDoc = new FakeDoc();
let lastOfferRejected = false;

function Harness({
	onApply,
}: {
	onApply: (entry: ToolProposalEntry, doc: FakeDoc) => Promise<void> | void;
}) {
	const { proposals, offer, dismiss } = useToolProposals();
	return (
		<>
			<button type="button" id="offer-good" onClick={() => offer(source, wire)}>
				good
			</button>
			<button
				type="button"
				id="offer-bad"
				onClick={() => {
					lastOfferRejected = !offer(source, { changes: "not-a-list" });
				}}
			>
				bad
			</button>
			<ToolProposalTray
				proposals={proposals}
				onApply={(entry) => onApply(entry, currentDoc)}
				onDismiss={dismiss}
				t={t}
			/>
		</>
	);
}

function mount(onApply: (entry: ToolProposalEntry, doc: FakeDoc) => Promise<void> | void) {
	currentDoc = new FakeDoc();
	lastOfferRejected = false;
	act(() => {
		root.render(<Harness onApply={onApply} />);
	});
	return currentDoc;
}

const click = (selector: string) => {
	const el = container.querySelector<HTMLElement>(selector);
	if (!el) throw new Error(`no element ${selector}`);
	act(() => {
		el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
};

describe("useToolProposals / ToolProposalTray", () => {
	it("offer stages a well-formed proposal and refuses a malformed one", () => {
		mount(() => {});
		expect(container.querySelector("[data-testid='tool-proposal-tray']")).toBeNull();
		click("#offer-good");
		expect(container.querySelectorAll("[data-testid='tool-proposal']")).toHaveLength(1);
		click("#offer-bad");
		expect(lastOfferRejected).toBe(true);
		expect(container.querySelectorAll("[data-testid='tool-proposal']")).toHaveLength(1);
	});

	it("renders the screened title, provider, summary and each diff row", () => {
		mount(() => {});
		click("#offer-good");
		const card = container.querySelector("[data-testid='tool-proposal']");
		expect(card?.textContent).toContain("Rewrite");
		expect(card?.textContent).toContain("io.example.p");
		expect(card?.textContent).toContain("Tidies the wording");
		const rows = container.querySelectorAll("[data-testid='tool-proposal-change']");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.querySelector("del")?.textContent).toBe("old title");
		expect(rows[0]?.querySelector("ins")?.textContent).toBe("new title");
	});

	it("apply hands the WHOLE proposal to ONE onApply call — one transaction, one undo step", async () => {
		const doc = mount((entry, d) => {
			d.transact(() => {
				for (const change of entry.proposal.changes) d.writes.push([change.key, change.after]);
			});
		});
		click("#offer-good");
		click("[data-testid='tool-proposal-apply']");
		await act(async () => {});
		expect(doc.transactions).toBe(1);
		expect(doc.writes).toEqual([
			["title", "new title"],
			["body", "new body"],
		]);
		// A successful apply retires the card.
		expect(container.querySelector("[data-testid='tool-proposal']")).toBeNull();
	});

	it("a failed apply keeps the card and renders OUR failure line, never the error text", async () => {
		mount(() => {
			throw new Error("SECRET driver detail");
		});
		click("#offer-good");
		click("[data-testid='tool-proposal-apply']");
		await act(async () => {});
		const card = container.querySelector("[data-testid='tool-proposal']");
		expect(card).not.toBeNull();
		const error = container.querySelector("[data-testid='tool-proposal-error']");
		expect(error?.textContent).toBe("tool.proposal.applyFailed");
		expect(container.textContent).not.toContain("SECRET");
		// Buttons re-enable so the user can retry or dismiss.
		expect(
			container.querySelector<HTMLButtonElement>("[data-testid='tool-proposal-apply']")?.disabled,
		).toBe(false);
	});

	it("dismiss removes the card without applying", async () => {
		const onApply = vi.fn();
		mount(onApply);
		click("#offer-good");
		click("[data-testid='tool-proposal-dismiss']");
		await act(async () => {});
		expect(onApply).not.toHaveBeenCalled();
		expect(container.querySelector("[data-testid='tool-proposal']")).toBeNull();
	});
});

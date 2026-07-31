// @vitest-environment jsdom
/**
 * The proposal card's states (Agent-Teams-3): pending offers the two decisions,
 * both buttons freeze while one is in flight, a rejected decision is SHOWN, and
 * a settled card reports its outcome instead of re-offering the choice.
 */

import { ProposeKind } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ChannelProposal,
	ChannelProposalStatus,
	ProposalDecision,
	ProposalDecisionFailure,
	type ProposalDecisionResult,
} from "./logic/proposal";
import { ProposalCard, type ProposalHost } from "./proposal-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

function proposal(over: Partial<ChannelProposal> = {}): ChannelProposal {
	return {
		artifact: {
			id: "prop-1",
			kind: ProposeKind.Task,
			entityType: "brainstorm/Task/v1",
			fields: { title: "Ship the release notes", dueDate: "2026-08-02" },
			summary: "Ship the release notes",
		},
		status: ChannelProposalStatus.Pending,
		...over,
	};
}

function mount(p: ChannelProposal, host: Partial<ProposalHost> = {}): ProposalHost {
	const full: ProposalHost = {
		canDecide: true,
		decide: vi.fn(
			async (): Promise<ProposalDecisionResult> => ({
				ok: true,
				status: ChannelProposalStatus.Approved,
			}),
		),
		open: vi.fn(),
		...host,
	};
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root.render(<ProposalCard messageId="m-1" proposal={p} host={full} />);
	});
	return full;
}

const byTestId = (id: string): HTMLElement | null =>
	container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const button = (id: string): HTMLButtonElement =>
	container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`) as HTMLButtonElement;

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("ProposalCard — pending", () => {
	it("shows the kind, the summary and the fields as label/value rows", () => {
		mount(proposal());
		expect(byTestId("chat-proposal-kind")?.textContent).toContain("Task");
		expect(container.querySelector(".chat__proposal-summary")?.textContent).toBe(
			"Ship the release notes",
		);
		const labels = [...container.querySelectorAll(".chat__proposal-field-label")].map(
			(n) => n.textContent,
		);
		const values = [...container.querySelectorAll(".chat__proposal-field-value")].map(
			(n) => n.textContent,
		);
		expect(labels).toEqual(["Title", "Due date"]);
		expect(values).toEqual(["Ship the release notes", "2026-08-02"]);
	});

	it("approves through the host", async () => {
		const host = mount(proposal());
		await act(async () => {
			button("chat-proposal-approve").click();
		});
		expect(host.decide).toHaveBeenCalledWith("m-1", ProposalDecision.Approve);
	});

	it("discards through the host", async () => {
		const host = mount(proposal());
		await act(async () => {
			button("chat-proposal-discard").click();
		});
		expect(host.decide).toHaveBeenCalledWith("m-1", ProposalDecision.Discard);
	});

	it("freezes both buttons while a decision is in flight", async () => {
		let settle: ((result: ProposalDecisionResult) => void) | undefined;
		const decide = vi.fn(
			() =>
				new Promise<ProposalDecisionResult>((resolve) => {
					settle = resolve;
				}),
		);
		mount(proposal(), { decide });
		await act(async () => {
			button("chat-proposal-approve").click();
		});
		expect(button("chat-proposal-approve").disabled).toBe(true);
		expect(button("chat-proposal-discard").disabled).toBe(true);
		// A second click on either cannot mint a second privileged write.
		await act(async () => {
			button("chat-proposal-discard").click();
		});
		expect(decide).toHaveBeenCalledTimes(1);
		await act(async () => {
			settle?.({ ok: true, status: ChannelProposalStatus.Approved });
		});
	});

	it("surfaces a rejected decision instead of swallowing it", async () => {
		mount(proposal(), {
			decide: vi.fn(async () => ({
				ok: false as const,
				reason: ProposalDecisionFailure.AlreadyDecided,
			})),
		});
		await act(async () => {
			button("chat-proposal-approve").click();
		});
		const error = byTestId("chat-proposal-error");
		expect(error?.textContent).toBe("Someone already decided this one.");
		expect(error?.getAttribute("role")).toBe("alert");
		// The user can try the other decision once the failure is shown.
		expect(button("chat-proposal-approve").disabled).toBe(false);
	});

	it("falls back to a generic message for an unrecognised reason", async () => {
		mount(proposal(), {
			decide: vi.fn(async () => ({ ok: false as const, reason: "something-new" })),
		});
		await act(async () => {
			button("chat-proposal-approve").click();
		});
		expect(byTestId("chat-proposal-error")?.textContent).toBe("Couldn't decide that — try again.");
	});

	it("disables the decisions with a visible explanation when the host offers none", async () => {
		const host = mount(proposal(), { canDecide: false });
		expect(button("chat-proposal-approve").disabled).toBe(true);
		expect(button("chat-proposal-discard").disabled).toBe(true);
		expect(button("chat-proposal-approve").title).toBe("Approving isn't available here.");
		expect(byTestId("chat-proposal-unavailable")?.textContent).toBe(
			"Approving isn't available here.",
		);
		await act(async () => {
			button("chat-proposal-approve").click();
		});
		expect(host.decide).not.toHaveBeenCalled();
	});
});

describe("ProposalCard — settled", () => {
	it("reports an approval and opens what it created", async () => {
		const host = mount(
			proposal({ status: ChannelProposalStatus.Approved, createdEntityId: "ent_42" }),
		);
		expect(byTestId("chat-proposal-approve")).toBeNull();
		expect(byTestId("chat-proposal-discard")).toBeNull();
		expect(byTestId("chat-proposal-outcome")?.textContent).toContain(
			"Approved — saved to your vault",
		);
		await act(async () => {
			button("chat-proposal-open").click();
		});
		expect(host.open).toHaveBeenCalledWith("ent_42", "brainstorm/Task/v1");
	});

	it("offers no back-link when an approval recorded no entity", () => {
		mount(proposal({ status: ChannelProposalStatus.Approved }));
		expect(byTestId("chat-proposal-open")).toBeNull();
	});

	it("reports a discard and still shows what was proposed", () => {
		mount(proposal({ status: ChannelProposalStatus.Discarded }));
		expect(byTestId("chat-proposal-outcome")?.textContent).toContain("Discarded — nothing was saved");
		expect(byTestId("chat-proposal-approve")).toBeNull();
		expect(container.querySelector(".chat__proposal-summary")?.textContent).toBe(
			"Ship the release notes",
		);
	});
});

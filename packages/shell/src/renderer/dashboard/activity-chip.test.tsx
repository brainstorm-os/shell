// @vitest-environment jsdom
/**
 * Background-activity chip + popover. The chip is present only while work is in
 * flight, summarises the freshest op (title + percent, or "N tasks"), and
 * swaps to a warning glyph on any error. The popover lists a row + bar per op.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ActivityKind,
	ActivityPhase,
	type ActivitySnapshot,
	type BackgroundOperation,
} from "../../activity-types";
import { ActivityChip } from "./activity-chip";
import { ActivityPopover } from "./activity-popover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const op = (over: Partial<BackgroundOperation> = {}): BackgroundOperation => ({
	id: "op",
	kind: ActivityKind.ModelDownload,
	phase: ActivityPhase.Running,
	percent: null,
	detail: null,
	...over,
});

describe("ActivityChip", () => {
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
	});

	const render = (snapshot: ActivitySnapshot) => {
		act(() => root.render(<ActivityChip override={snapshot} />));
	};

	it("renders nothing when there is no background work", () => {
		render({ operations: [] });
		expect(host.querySelector(".activity-chip")).toBeNull();
	});

	it("shows the single op title + percent while downloading", () => {
		render({ operations: [op({ percent: 42 })] });
		expect(host.querySelector(".activity-chip")).not.toBeNull();
		expect(host.textContent).toContain("Downloading model");
		expect(host.textContent).toContain("42%");
	});

	it("summarises multiple operations as a count", () => {
		render({
			operations: [op({ id: "a" }), op({ id: "b", kind: ActivityKind.Indexing })],
		});
		expect(host.textContent).toContain("2 tasks");
	});

	it("flags an error state on the chip", () => {
		render({ operations: [op({ phase: ActivityPhase.Error, detail: "offline" })] });
		expect(host.querySelector(".activity-chip--error")).not.toBeNull();
		// No percent shown for a non-running op.
		expect(host.querySelector(".activity-chip__percent")).toBeNull();
	});
});

describe("ActivityPopover", () => {
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
	});

	// The shared <Popover> portals to document.body, so query there.
	const rows = () => document.querySelectorAll('[data-testid="activity-popover-row"]');

	it("renders a row per operation with a determinate bar", () => {
		act(() =>
			root.render(
				<ActivityPopover
					operations={[op({ percent: 30 }), op({ id: "idx", kind: ActivityKind.Indexing })]}
					onClose={() => {}}
				/>,
			),
		);
		expect(rows()).toHaveLength(2);
		const fill = document.querySelector<HTMLElement>(
			'[data-testid="activity-popover-row"] .activity-popover__bar-fill',
		);
		expect(fill?.style.width).toBe("30%");
	});

	it("shows the error detail instead of a bar for a failed op", () => {
		act(() =>
			root.render(
				<ActivityPopover
					operations={[op({ phase: ActivityPhase.Error, detail: "network unreachable" })]}
					onClose={() => {}}
				/>,
			),
		);
		expect(document.body.textContent).toContain("network unreachable");
		expect(document.querySelector(".activity-popover__bar")).toBeNull();
	});
});

// @vitest-environment jsdom
import { getEscapeStack, installEscapeHandler } from "@brainstorm-os/sdk/a11y";
import { act, useState } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Popover } from "./popover";
import { PopoverBodyPadding, PopoverSize } from "./popover-types";

describe("Popover — KBN-S-popover focus restore", () => {
	let host: HTMLDivElement;
	let root: Root;
	let uninstallEscape: () => void;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		// In production the shell mounts this once in dashboard.tsx; for an
		// isolated component test we install the same handler against the
		// shared module-scope escape stack so the Escape key reaches the trap.
		uninstallEscape = installEscapeHandler(getEscapeStack());
	});

	afterEach(() => {
		uninstallEscape();
		act(() => root.unmount());
		host.remove();
	});

	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<div>
				<button type="button" data-testid="opener" onClick={() => setOpen(true)}>
					Open
				</button>
				{open ? (
					<Popover
						title="Confirm"
						onClose={() => setOpen(false)}
						size={PopoverSize.Small}
						bodyPadding={PopoverBodyPadding.Compact}
						testId="popover-panel"
					>
						<button type="button" data-testid="inside-1">
							First
						</button>
						<button type="button" data-testid="inside-2">
							Second
						</button>
					</Popover>
				) : null}
			</div>
		);
	}

	it("restores focus to the opener when the popover closes", () => {
		act(() => root.render(<Harness />));
		const opener = host.querySelector<HTMLButtonElement>('[data-testid="opener"]');
		opener?.focus();
		expect(document.activeElement).toBe(opener);
		act(() => opener?.click());
		// Popover mounted in a portal under <body>; useFocusTrap moves focus
		// into the first focusable inside the panel (the header IconButton).
		expect(document.activeElement).not.toBe(opener);
		expect(document.activeElement).not.toBe(document.body);
		// Close via Escape — routes through the shared escape stack.
		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		// React re-renders the harness; the popover unmounts; useFocusTrap's
		// cleanup restores focus to the captured opener.
		expect(document.activeElement).toBe(opener);
	});

	it("handles a removed opener cleanly (no throw, no dangling focus on the detached element)", () => {
		act(() => root.render(<Harness />));
		const opener = host.querySelector<HTMLButtonElement>('[data-testid="opener"]');
		opener?.focus();
		act(() => opener?.click());
		// Yank the opener out of the DOM mid-popover (route change / unmount).
		opener?.remove();
		// Close via Escape — useFocusTrap's cleanup guards against restoring to
		// a detached opener (document.body.contains check). Focus falls through
		// to body, which is acceptable; the critical invariant is no throw and
		// focus is not pinned to the removed node.
		expect(() => {
			act(() => {
				document.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
				);
			});
		}).not.toThrow();
		expect(document.body.contains(document.activeElement)).toBe(true);
	});
});

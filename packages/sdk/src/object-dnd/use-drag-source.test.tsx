// @vitest-environment jsdom
import { DragPayloadKind, DropEffect } from "@brainstorm-os/sdk-types";
import { useRef } from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDragSource } from "./use-drag-source";

let container: HTMLElement;
let root: Root;

function Harness() {
	const rowRef = useRef<HTMLDivElement | null>(null);
	const { dragHandleProps } = useDragSource({
		getItems: () => [{ entityId: "e1", entityType: "T", label: "One" }],
		suppressNativeDragRef: rowRef,
		// No controller wired → begin is a no-op; this test only covers the
		// native-drag suppression on the shared draggable ancestor.
		controller: {
			begin: async () => ({ sessionId: "s", payloadKind: DragPayloadKind.Object, itemCount: 1 }),
			move: async () => {},
			drop: async () => ({ delivered: false, effect: DropEffect.None, targetApp: null }),
			cancel: async () => {},
		},
	});
	return (
		<div ref={rowRef} draggable data-testid="row">
			<button type="button" data-testid="grip" {...dragHandleProps}>
				grip
			</button>
		</div>
	);
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("useDragSource suppressNativeDragRef", () => {
	it("flips the draggable ancestor off on pointerdown and restores on pointerup", () => {
		act(() => root.render(<Harness />));
		const row = container.querySelector<HTMLDivElement>('[data-testid="row"]');
		const grip = container.querySelector<HTMLButtonElement>('[data-testid="grip"]');
		if (!row || !grip) throw new Error("not mounted");
		expect(row.draggable).toBe(true);

		act(() => {
			grip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
		});
		expect(row.draggable).toBe(false);

		act(() => {
			window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
		});
		expect(row.draggable).toBe(true);
	});

	it("marks the handle grabbable to AT via aria-grabbed=false at rest (DND-6)", () => {
		act(() => root.render(<Harness />));
		const grip = container.querySelector<HTMLButtonElement>('[data-testid="grip"]');
		if (!grip) throw new Error("not mounted");
		expect(grip.getAttribute("aria-grabbed")).toBe("false");
	});

	it("restores the ancestor on pointercancel too", () => {
		act(() => root.render(<Harness />));
		const row = container.querySelector<HTMLDivElement>('[data-testid="row"]');
		const grip = container.querySelector<HTMLButtonElement>('[data-testid="grip"]');
		if (!row || !grip) throw new Error("not mounted");

		act(() => {
			grip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 2 }));
		});
		expect(row.draggable).toBe(false);
		act(() => {
			window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 2 }));
		});
		expect(row.draggable).toBe(true);
	});
});

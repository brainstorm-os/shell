// @vitest-environment jsdom
import {
	DragPayloadKind,
	type DropDelivery,
	DropEffect,
	type ObjectDragPayload,
} from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeObjectDragPayload } from "../entity-drag";
import { CROSS_APP_DROP_EVENT } from "./cross-app";
import { type DropTargetHandle, type DropTargetSpec, useDropTarget } from "./use-drop-target";

let container: HTMLElement;
let root: Root;
let handle: DropTargetHandle | null = null;

function Harness({ spec }: { spec: DropTargetSpec }) {
	handle = useDropTarget(spec);
	return <div data-over={handle.isOver ? "1" : "0"} />;
}

function mount(spec: DropTargetSpec): void {
	act(() => root.render(<Harness spec={spec} />));
}

/** Map-backed `DataTransfer` (jsdom's is incomplete for custom MIME). */
class FakeDataTransfer {
	private readonly store = new Map<string, string>();
	dropEffect = "none";
	setData(t: string, v: string): void {
		this.store.set(t, v);
	}
	getData(t: string): string {
		return this.store.get(t) ?? "";
	}
	get types(): string[] {
		return [...this.store.keys()];
	}
}

const PAYLOAD: ObjectDragPayload = {
	v: 1,
	sourceApp: "io.brainstorm.files",
	items: [{ entityId: "a", entityType: "T", label: "A" }],
};

function nativeEvent(withEntity: boolean): {
	clientX: number;
	clientY: number;
	dataTransfer: DataTransfer;
	preventDefault: () => void;
} {
	const dt = new FakeDataTransfer();
	if (withEntity)
		dt.setData("application/vnd.brainstorm.entity+json", serializeObjectDragPayload(PAYLOAD));
	return {
		clientX: 10,
		clientY: 20,
		dataTransfer: dt as unknown as DataTransfer,
		preventDefault: vi.fn(),
	};
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	handle = null;
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("useDropTarget — native transport", () => {
	it("accepts a drag carrying the entity MIME and onDrop fires with the payload", () => {
		const onDrop = vi.fn();
		mount({ accepts: () => true, onDrop });
		const ev = nativeEvent(true);
		act(() => handle?.dropProps.onDrop(ev));
		expect(ev.preventDefault).toHaveBeenCalled();
		expect(onDrop).toHaveBeenCalledWith(
			expect.objectContaining({ items: PAYLOAD.items }),
			expect.objectContaining({ itemTypes: ["T"] }),
			DropEffect.Link,
		);
	});

	it("ignores a drop with no entity payload", () => {
		const onDrop = vi.fn();
		mount({ accepts: () => true, onDrop });
		act(() => handle?.dropProps.onDrop(nativeEvent(false)));
		expect(onDrop).not.toHaveBeenCalled();
	});

	it("dragover preventDefaults + sets the DOM dropEffect when accepted", () => {
		mount({ accepts: () => true, dropEffectFor: () => DropEffect.Move, onDrop: vi.fn() });
		const ev = nativeEvent(true);
		act(() => handle?.dropProps.onDragOver(ev));
		expect(ev.preventDefault).toHaveBeenCalled();
		expect(ev.dataTransfer.dropEffect).toBe("move");
		expect(handle?.isOver).toBe(true);
	});

	it("dragover does NOT preventDefault when the effect is None", () => {
		mount({ accepts: () => true, dropEffectFor: () => DropEffect.None, onDrop: vi.fn() });
		const ev = nativeEvent(true);
		act(() => handle?.dropProps.onDragOver(ev));
		expect(ev.preventDefault).not.toHaveBeenCalled();
	});

	it("respects nativeDisabled (cross-app only)", () => {
		const onDrop = vi.fn();
		mount({ nativeDisabled: true, accepts: () => true, onDrop });
		act(() => handle?.dropProps.onDrop(nativeEvent(true)));
		expect(onDrop).not.toHaveBeenCalled();
	});

	it("exposes aria-dropeffect while hovered and clears it on leave (DND-6)", () => {
		mount({ accepts: () => true, dropEffectFor: () => DropEffect.Move, onDrop: vi.fn() });
		expect(handle?.dropProps["aria-dropeffect"]).toBeUndefined();
		act(() => handle?.dropProps.onDragOver(nativeEvent(true)));
		expect(handle?.dropProps["aria-dropeffect"]).toBe(DropEffect.Move);
		const leave = { ...nativeEvent(true), currentTarget: null, relatedTarget: null };
		act(() => handle?.dropProps.onDragLeave(leave));
		expect(handle?.dropProps["aria-dropeffect"]).toBeUndefined();
	});
});

describe("useDropTarget — cross-app transport", () => {
	it("receives a shell-delivered drop via the window event", () => {
		const onDrop = vi.fn();
		mount({ accepts: () => true, onDrop });
		const delivery: DropDelivery = {
			sessionId: "s1",
			payloadKind: DragPayloadKind.Object,
			payload: PAYLOAD,
			pointInWindow: { x: 3, y: 4 },
			effect: DropEffect.Link,
		};
		act(() => {
			window.dispatchEvent(new CustomEvent(CROSS_APP_DROP_EVENT, { detail: delivery }));
		});
		expect(onDrop).toHaveBeenCalledWith(
			PAYLOAD,
			expect.objectContaining({ itemTypes: ["T"] }),
			DropEffect.Link,
		);
	});
});

// @vitest-environment jsdom
/**
 * The engine's *command surface* — the methods the React chrome calls from a
 * toolbar button or a fancy-menu row (`createSticky`, `setTool`,
 * `alignSelection`, `toggleSelectionBold`, …).
 *
 * The gap this closes: the whiteboard suite tests the pure logic modules
 * (`logic/align`, `logic/z-order`, `logic/node-factory`) thoroughly, and the
 * pointer/keyboard pipelines through `<WhiteboardApp>` — but nothing exercised
 * the commands themselves. A menu row wired to a command that no longer moves
 * the board (or is guarded shut) would leave every one of those tests green
 * while the menu item is dead in the product.
 *
 * These drive the real engine over a real (jsdom) DOM and assert on what the
 * user would see: the node layer, the chrome snapshot the header renders from,
 * and the style menu's own checked state.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ToolId, type WhiteboardEngine, createWhiteboardEngine } from "./engine";
import { AlignKind, DistributeAxis } from "./logic/align";
import { ZOrderOp } from "./logic/z-order";
import { ShapeKind } from "./types/node";

let engine: WhiteboardEngine | null = null;

afterEach(() => {
	engine?.dispose();
	engine = null;
	document.body.replaceChildren();
	// `installDevHook` is install-once per window — without this the next
	// engine silently inherits the disposed one's hook.
	Reflect.deleteProperty(window, "__brainstormWhiteboardDev");
});

function mount(): WhiteboardEngine {
	const root = document.createElement("div");
	const canvas = document.createElement("div");
	const layers = document.createElement("div");
	const navList = document.createElement("div");
	root.append(canvas, layers, navList);
	document.body.append(root);
	const next = createWhiteboardEngine({ root, canvas, layers, navList });
	next.start();
	engine = next;
	return next;
}

function dev() {
	const hook = window.__brainstormWhiteboardDev;
	if (!hook) throw new Error("dev hook missing — engine did not boot");
	return hook;
}

const nodeIds = (): string[] => dev().nodeIds();

function nodeEl(id: string): HTMLElement {
	const el = dev().nodeEl(id);
	if (!el) throw new Error(`no DOM node for "${id}"`);
	return el;
}

/** The node's kind, read the way the renderer writes it. */
function kindOf(id: string): string {
	const sig = nodeEl(id).dataset.contentSig;
	return sig ? (JSON.parse(sig).kind as string) : "";
}

const selectedIds = (): string[] =>
	nodeIds().filter((id) => nodeEl(id).getAttribute("aria-selected") === "true");

const leftOf = (id: string): number => Number.parseFloat(nodeEl(id).style.left);
const topOf = (id: string): number => Number.parseFloat(nodeEl(id).style.top);
const zOf = (id: string): number => Number.parseFloat(nodeEl(id).style.zIndex || "0");

function key(target: EventTarget, k: string, init: KeyboardEventInit = {}): void {
	target.dispatchEvent(
		new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
	);
}

/** A plain pointer click on a node — the engine's real selection path. */
function clickNode(id: string): void {
	const el = nodeEl(id);
	el.dispatchEvent(
		new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1 }),
	);
	el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1 }));
}

/**
 * Two stickies, both selected. A freshly created node lands in inline edit and
 * owns the keyboard (the F-213 contract), so Escape has to commit it before the
 * select-all chord can reach the canvas.
 */
function twoSelectedStickies(e: WhiteboardEngine): [string, string] {
	e.createSticky();
	e.createSticky();
	key(document, "Escape");
	key(window, "a", { ctrlKey: true });
	const ids = nodeIds();
	if (ids.length !== 2) throw new Error(`expected 2 nodes, got ${ids.length}`);
	return [ids[0] as string, ids[1] as string];
}

/** The Emphasis submenu row's icon — the style menu's own "is it on" state. */
function emphasisIcon(e: WhiteboardEngine, label: string): string | undefined {
	type Row = { label?: string; icon?: string; submenu?: Row[] };
	const rows = e.styleMenuItems() as unknown as Row[];
	const emphasis = rows.find((row) => row.submenu?.some((sub) => sub.label === label));
	return emphasis?.submenu?.find((sub) => sub.label === label)?.icon;
}

describe("engine command surface — creation", () => {
	it("createSticky adds a sticky and leaves it selected", () => {
		const e = mount();
		e.createSticky();
		const ids = nodeIds();
		expect(ids).toHaveLength(1);
		expect(kindOf(ids[0] as string)).toBe("sticky");
		expect(selectedIds()).toEqual(ids);
	});

	it("each creation command adds a node of its own kind", () => {
		const e = mount();
		e.createText();
		e.createFrame();
		e.createRectangle();
		e.createEllipse();
		e.createShape(ShapeKind.Diamond);
		expect(nodeIds().map(kindOf)).toEqual(["text", "frame", "shape", "shape", "shape"]);
	});

	it("successive creations cascade instead of stacking on one spot", () => {
		const e = mount();
		e.createSticky();
		e.createSticky();
		const [a, b] = nodeIds() as [string, string];
		expect([leftOf(b), topOf(b)]).not.toEqual([leftOf(a), topOf(a)]);
	});
});

describe("engine command surface — setTool", () => {
	it("setTool moves the chrome snapshot the toolbar paints from", () => {
		const e = mount();
		expect(e.getSnapshot().tool).toBe(ToolId.Select);
		e.setTool(ToolId.Sticky);
		expect(e.getSnapshot().tool).toBe(ToolId.Sticky);
	});

	it("notifies subscribers so the React toolbar re-renders", () => {
		const e = mount();
		const seen: string[] = [];
		const off = e.subscribe(() => seen.push(e.getSnapshot().tool));
		e.setTool(ToolId.Pen);
		off();
		expect(seen.at(-1)).toBe(ToolId.Pen);
	});
});

describe("engine command surface — alignSelection", () => {
	it("aligns the selection's left edges", () => {
		const e = mount();
		const [a, b] = twoSelectedStickies(e);
		expect(leftOf(a)).not.toBe(leftOf(b));
		e.alignSelection(AlignKind.Left);
		expect(leftOf(a)).toBe(leftOf(b));
	});

	it("aligns the selection's top edges", () => {
		const e = mount();
		const [a, b] = twoSelectedStickies(e);
		expect(topOf(a)).not.toBe(topOf(b));
		e.alignSelection(AlignKind.Top);
		expect(topOf(a)).toBe(topOf(b));
	});

	it("is a no-op below two selected nodes (the menu row can't move a lone node)", () => {
		const e = mount();
		e.createSticky();
		const [only] = nodeIds() as [string];
		const before = [leftOf(only), topOf(only)];
		e.alignSelection(AlignKind.Right);
		expect([leftOf(only), topOf(only)]).toEqual(before);
	});

	it("distributeSelection needs three nodes and leaves two untouched", () => {
		const e = mount();
		const [a, b] = twoSelectedStickies(e);
		const before = [leftOf(a), leftOf(b)];
		e.distributeSelection(DistributeAxis.Horizontal);
		expect([leftOf(a), leftOf(b)]).toEqual(before);
	});
});

describe("engine command surface — text emphasis", () => {
	it("toggleSelectionBold turns bold on, and the style menu reports it checked", () => {
		const e = mount();
		twoSelectedStickies(e);
		expect(emphasisIcon(e, "Bold")).toBeUndefined();
		e.toggleSelectionBold();
		expect(emphasisIcon(e, "Bold")).toBe("check-circle");
	});

	it("toggleSelectionBold toggles back off", () => {
		const e = mount();
		twoSelectedStickies(e);
		e.toggleSelectionBold();
		e.toggleSelectionBold();
		expect(emphasisIcon(e, "Bold")).toBeUndefined();
	});

	it("bold and italic are independent", () => {
		const e = mount();
		twoSelectedStickies(e);
		e.toggleSelectionItalic();
		expect(emphasisIcon(e, "Italic")).toBe("check-circle");
		expect(emphasisIcon(e, "Bold")).toBeUndefined();
	});

	it("an empty selection has no style menu at all (the header button is disabled)", () => {
		const e = mount();
		expect(e.getSnapshot().canStyle).toBe(false);
		expect(e.styleMenuItems()).toEqual([]);
	});
});

describe("engine command surface — z-order", () => {
	it("applyZOrder(ToFront) moves the selected node last in the paint order", () => {
		const e = mount();
		e.createSticky();
		e.createSticky();
		key(document, "Escape");
		const [a, b] = nodeIds() as [string, string];
		// Click the back node — the single-selection case the Arrange menu's
		// Bring-to-front row acts on.
		clickNode(a);
		expect(selectedIds()).toEqual([a]);
		e.applyZOrder(ZOrderOp.ToFront);
		// The op is a dense re-stack via each node's CSS z-index, not an array
		// reorder — assert what the renderer actually paints.
		expect(zOf(a)).toBeGreaterThan(zOf(b));
		e.applyZOrder(ZOrderOp.ToBack);
		expect(zOf(a)).toBeLessThan(zOf(b));
	});
});

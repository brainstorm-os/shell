// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_HIDE_SIDEBARS_ATTRIBUTE, AutoHideFace } from "./auto-hide";
import { PanelSide } from "./panel-toggle-icon";
import { type AutoHidePanel, useAutoHidePanel } from "./use-auto-hide-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: AutoHidePanel | null = null;

function Sidebar({ collapsed }: { collapsed: boolean }) {
	const panel = useAutoHidePanel({ side: PanelSide.Left, collapsed, revealDelayMs: 50 });
	latest = panel;
	return (
		<div>
			{panel.edgeProps && <div data-testid="edge" {...panel.edgeProps} />}
			<aside
				data-testid="panel"
				{...panel.panelProps}
				aria-hidden={!panel.visible}
				inert={panel.visible ? undefined : true}
			>
				<button type="button">First</button>
			</aside>
		</div>
	);
}

describe("useAutoHidePanel (7.15)", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.useFakeTimers();
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		document.documentElement.removeAttribute(AUTO_HIDE_SIDEBARS_ATTRIBUTE);
		vi.useRealTimers();
	});

	const panel = () => host.querySelector('[data-testid="panel"]') as HTMLElement;
	const edge = () => host.querySelector('[data-testid="edge"]');

	it("is inert while the preference is off: no edge, no overlay face", () => {
		act(() => root.render(<Sidebar collapsed />));
		expect(edge()).toBeNull();
		expect(panel().hasAttribute("data-bs-autohide")).toBe(false);
		expect(panel().getAttribute("aria-hidden")).toBe("true");
	});

	it("a pinned-open sidebar is untouched even with the preference on", () => {
		document.documentElement.setAttribute(AUTO_HIDE_SIDEBARS_ATTRIBUTE, "on");
		act(() => root.render(<Sidebar collapsed={false} />));
		expect(edge()).toBeNull();
		expect(latest?.visible).toBe(true);
	});

	it("collapsed + preference on: hidden overlay stays out of the tab order until edge hover reveals it", () => {
		document.documentElement.setAttribute(AUTO_HIDE_SIDEBARS_ATTRIBUTE, "on");
		act(() => root.render(<Sidebar collapsed />));
		expect(panel().getAttribute("data-bs-autohide")).toBe(AutoHideFace.Hidden);
		expect(panel().hasAttribute("inert")).toBe(true);
		act(() => latest?.edgeProps?.onPointerEnter());
		act(() => vi.advanceTimersByTime(50));
		expect(panel().getAttribute("data-bs-autohide")).toBe(AutoHideFace.Revealed);
		expect(panel().hasAttribute("inert")).toBe(false);
		expect(panel().getAttribute("aria-hidden")).toBe("false");
	});

	it("the shortcut path reveals and moves focus in; Escape hides", () => {
		document.documentElement.setAttribute(AUTO_HIDE_SIDEBARS_ATTRIBUTE, "on");
		act(() => root.render(<Sidebar collapsed />));
		act(() => latest?.toggle());
		expect(document.activeElement?.textContent).toBe("First");
		act(() => {
			panel().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(panel().getAttribute("data-bs-autohide")).toBe(AutoHideFace.Hidden);
	});

	it("follows the preference live when the shell flips the root attribute", async () => {
		act(() => root.render(<Sidebar collapsed />));
		expect(latest?.active).toBe(false);
		await act(async () => {
			document.documentElement.setAttribute(AUTO_HIDE_SIDEBARS_ATTRIBUTE, "on");
			await Promise.resolve();
		});
		expect(latest?.active).toBe(true);
	});
});

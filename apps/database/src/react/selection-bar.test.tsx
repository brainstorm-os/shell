// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectionBar } from "./mount";

let root: Root | null = null;
afterEach(() => {
	act(() => root?.unmount());
	document.body.replaceChildren();
});

describe("SelectionBar bulk actions (9.12.32)", () => {
	it("renders each action as a button that reports its anchor", () => {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		const onSet = vi.fn();
		act(() =>
			root?.render(
				<SelectionBar
					count={3}
					countLabel="3 selected"
					clearLabel="Clear"
					onClear={vi.fn()}
					actions={[{ id: "set-property", label: "Set property…", opensMenu: true, onClick: onSet }]}
				/>,
			),
		);
		const btn = host.querySelector<HTMLButtonElement>('[data-testid="db-selection-set-property"]');
		expect(btn?.getAttribute("aria-haspopup")).toBe("menu");
		act(() => btn?.click());
		expect(onSet).toHaveBeenCalledWith(btn);
		expect(host.textContent).toContain("3 selected");
	});
});

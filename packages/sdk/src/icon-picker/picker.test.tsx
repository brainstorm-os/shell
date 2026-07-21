// @vitest-environment jsdom
/**
 * IconPicker render/contract smoke: the shared picker is host-agnostic —
 * every chrome string comes from `labels`, the backdrop + Remove action
 * drive `onClose`/`onChange(null)`, and tab switching is local. jsdom has
 * no layout engine, so the virtualised grids render empty here (covered
 * by `emoji-data.test.ts` + the host apps); these assertions pin the
 * label wiring + the close/remove contract every host depends on.
 */

import { IconKind } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IconPicker, type IconPickerLabels } from "./picker";

const LABELS: IconPickerLabels = {
	region: "Pick icon",
	close: "Close picker",
	remove: "Remove icon",
	search: "Search glyphs",
	noMatch: "Nothing found",
	tabEmoji: "Emoji",
	tabIcon: "Icon",
	tabUpload: "Upload",
	tabLibrary: "Library",
	uploadPending: "Upload pending",
	libraryPending: "Library pending",
	uploadAction: "Choose image…",
	uploading: "Uploading…",
	libraryEmpty: "No custom icons yet",
	skinToneRegion: "Skin tone",
	skinToneOption: "Skin tone: {tone}",
	skinToneNames: {
		none: "Default",
		light: "Light",
		mediumLight: "Medium-light",
		medium: "Medium",
		mediumDark: "Medium-dark",
		dark: "Dark",
	},
	tintRegion: "Glyph colour",
	tintOption: "Colour {color}",
	tintCustom: "Custom colour",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	if (!("ResizeObserver" in window)) {
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("IconPicker (shared SDK component)", () => {
	it("labels every chrome surface from the injected labels", () => {
		act(() => {
			root.render(<IconPicker value={null} onChange={() => {}} onClose={() => {}} labels={LABELS} />);
		});
		const dialog = container.querySelector('[role="dialog"]');
		expect(dialog?.getAttribute("aria-label")).toBe("Pick icon");
		const tabs = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
		expect(tabs).toEqual(["Emoji", "Icon", "Upload", "Library"]);
		expect(container.querySelector(".icon-picker__action")?.getAttribute("aria-label")).toBe(
			"Remove icon",
		);
		expect(container.querySelector(".icon-picker__backdrop")?.getAttribute("aria-label")).toBe(
			"Close picker",
		);
	});

	it("Remove action clears the icon and closes", () => {
		const onChange = vi.fn();
		const onClose = vi.fn();
		act(() => {
			root.render(<IconPicker value={null} onChange={onChange} onClose={onClose} labels={LABELS} />);
		});
		act(() => {
			(container.querySelector(".icon-picker__action") as HTMLButtonElement).click();
		});
		expect(onChange).toHaveBeenCalledWith(null);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("opens on the Icon tab when the value is a pack glyph", () => {
		act(() => {
			root.render(
				<IconPicker
					value={{ kind: IconKind.Pack, value: "phosphor/star" }}
					onChange={() => {}}
					onClose={() => {}}
					labels={LABELS}
				/>,
			);
		});
		const active = container.querySelector('[role="tab"][aria-selected="true"]');
		expect(active?.textContent).toBe("Icon");
	});

	it("backdrop click closes without mutating the icon", () => {
		const onChange = vi.fn();
		const onClose = vi.fn();
		act(() => {
			root.render(<IconPicker value={null} onChange={onChange} onClose={onClose} labels={LABELS} />);
		});
		act(() => {
			(container.querySelector(".icon-picker__backdrop") as HTMLButtonElement).click();
		});
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();
	});
});

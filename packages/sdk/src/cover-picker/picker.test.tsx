// @vitest-environment jsdom
/**
 * CoverPicker render/contract smoke. Host-agnostic: chrome strings come
 * from `labels`, the cover store is the injected `covers` stub, and the
 * combined Color (gradient + solid) picks + Remove + backdrop drive the
 * documented onChange/onClose contract every host (and B7.3 adoption)
 * depends on.
 */

import { type Cover, CoverKind } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoverPicker, type CoverPickerLabels, type CoverPickerService } from "./picker";

const LABELS: CoverPickerLabels = {
	region: "Pick cover",
	close: "Close cover picker",
	remove: "Remove cover",
	tabImage: "Image",
	tabGallery: "Color",
	tabReposition: "Reposition",
	upload: "Upload",
	uploading: "Uploading…",
	dropHint: "Drag or click",
	libraryEmpty: "No covers yet",
	focalHint: "Drag to reframe",
	useCover: "Use cover",
	galleryRegion: "Gradient and colour covers",
};

const coversStub: CoverPickerService = {
	uploadBytes: vi.fn(async () => ({ url: "brainstorm://cover/a.png", thumbUrl: "x" })),
	list: vi.fn(async () => []),
};

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
	vi.clearAllMocks();
});

function render(props: Partial<Parameters<typeof CoverPicker>[0]> = {}) {
	const onChange = vi.fn();
	const onClose = vi.fn();
	act(() => {
		root.render(
			<CoverPicker
				value={null}
				onChange={onChange}
				onClose={onClose}
				labels={LABELS}
				covers={coversStub}
				{...props}
			/>,
		);
	});
	return { onChange, onClose };
}

describe("CoverPicker (shared SDK component)", () => {
	it("labels every chrome surface from the injected labels", () => {
		render();
		expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Pick cover");
		expect([...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
			"Image",
			"Color",
		]);
		// Remove is an icon-only button — its accessible name is the label.
		expect(container.querySelector(".icon-picker__action")?.getAttribute("aria-label")).toBe(
			"Remove cover",
		);
	});

	it("Remove clears the cover and closes", () => {
		const { onChange, onClose } = render();
		act(() => (container.querySelector(".icon-picker__action") as HTMLButtonElement).click());
		expect(onChange).toHaveBeenCalledWith(null);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	const openColorTab = () => {
		const tab = [...container.querySelectorAll('[role="tab"]')].find(
			(t) => t.textContent === "Color",
		) as HTMLButtonElement;
		act(() => tab.click());
	};

	it("a gradient swatch stages a Gradient cover that Apply commits", () => {
		const { onChange, onClose } = render();
		openColorTab();
		// The grid leads with gradients; the first swatch is one.
		const swatch = container.querySelector(".cover-picker__swatch") as HTMLButtonElement;
		expect(swatch).not.toBeNull();
		// A pick stages (no commit / close yet) and marks the swatch active.
		act(() => swatch.click());
		expect(onChange).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(container.querySelector(".cover-picker__swatch--active")).not.toBeNull();
		// Apply commits the staged cover and closes.
		act(() => (container.querySelector(".cover-picker__apply") as HTMLButtonElement).click());
		expect(onChange).toHaveBeenCalledTimes(1);
		const arg = onChange.mock.calls[0]?.[0] as Cover;
		expect(arg.kind).toBe(CoverKind.Gradient);
		expect(typeof arg.value).toBe("string");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("a colour swatch in the same grid stages a Color cover (theme token)", () => {
		const { onChange } = render();
		openColorTab();
		const tokenSwatch = [...container.querySelectorAll(".cover-picker__swatch")].find((s) =>
			s.getAttribute("aria-label")?.startsWith("--color-"),
		) as HTMLButtonElement;
		expect(tokenSwatch).not.toBeNull();
		act(() => tokenSwatch.click());
		act(() => (container.querySelector(".cover-picker__apply") as HTMLButtonElement).click());
		const arg = onChange.mock.calls[0]?.[0] as Cover;
		expect(arg.kind).toBe(CoverKind.Color);
		expect(arg.value.startsWith("--color-")).toBe(true);
	});

	it("Apply is disabled until a change is staged", () => {
		render();
		const apply = () => container.querySelector(".cover-picker__apply") as HTMLButtonElement;
		expect(apply().disabled).toBe(true);
		openColorTab();
		act(() => (container.querySelector(".cover-picker__swatch") as HTMLButtonElement).click());
		expect(apply().disabled).toBe(false);
	});

	it("opens on the Color tab when the value is a gradient or colour cover", () => {
		render({ value: { kind: CoverKind.Gradient, value: "coral" } as Cover });
		expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Color");
	});

	it("offers Reposition only while an image cover is staged, on its own tab", () => {
		// No image staged → just the two selection tabs.
		const { onChange } = render();
		expect([...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
			"Image",
			"Color",
		]);

		// An image cover → a third Reposition tab appears; it owns the focal
		// control and does NOT also render the duplicate preview band.
		act(() => root.unmount());
		root = createRoot(container);
		act(() => {
			root.render(
				<CoverPicker
					value={{ kind: CoverKind.Image, value: "brainstorm://cover/x.png" } as Cover}
					onChange={onChange}
					onClose={vi.fn()}
					labels={LABELS}
					covers={coversStub}
				/>,
			);
		});
		const tabNames = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
		expect(tabNames).toEqual(["Image", "Color", "Reposition"]);
		expect(container.querySelector(".cover-picker__focal")).toBeNull();

		const repositionTab = [...container.querySelectorAll('[role="tab"]')].find(
			(t) => t.textContent === "Reposition",
		) as HTMLButtonElement;
		act(() => repositionTab.click());
		expect(container.querySelector(".cover-picker__focal")).not.toBeNull();
		// Selection-step preview band is suppressed on the Reposition tab —
		// the drag surface is the preview (no two-images mess).
		expect(container.querySelector(".cover-picker__preview")).toBeNull();
	});

	it("backdrop closes without mutating the cover", () => {
		const { onChange, onClose } = render();
		act(() => (container.querySelector(".icon-picker__backdrop") as HTMLButtonElement).click());
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();
	});
});

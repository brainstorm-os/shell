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
import { iconUploadFromIcons } from "./icon-upload";
import { IconPicker, type IconPickerLabels, type IconUploadService } from "./picker";

const LABELS: IconPickerLabels = {
	region: "Pick icon",
	close: "Close picker",
	remove: "Remove icon",
	search: "Search glyphs",
	noMatch: "Nothing found",
	recent: "Recent",
	tabEmoji: "Emoji",
	tabIcon: "Icon",
	tabUpload: "Upload",
	tabLibrary: "Library",
	uploadPending: "Upload pending",
	libraryPending: "Library pending",
	uploadAction: "Choose image…",
	uploading: "Uploading…",
	dropHint: "Drop an image here",
	unsupportedFile: "Unsupported file",
	libraryEmpty: "No custom icons yet",
	loading: "Loading library…",
	libraryItem: "Uploaded icon",
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

	function clickTab(label: string) {
		const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
			(t) => t.textContent === label,
		);
		if (!tab) throw new Error(`no tab ${label}`);
		act(() => tab.click());
	}

	function flush() {
		return act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
	}

	function service(list: { url: string; thumbUrl: string }[] = []): IconUploadService {
		return {
			upload: vi.fn(async (name: string) => ({
				url: `brainstorm://icon/${name}`,
				thumbUrl: `thumb:${name}`,
			})),
			list: vi.fn(async () => list),
		};
	}

	it("Upload tab is a drop zone that fills the body, with no stray footer", () => {
		act(() => {
			root.render(
				<IconPicker
					value={null}
					onChange={() => {}}
					onClose={() => {}}
					labels={LABELS}
					iconUpload={service()}
				/>,
			);
		});
		clickTab("Upload");
		const zone = container.querySelector<HTMLButtonElement>(".icon-picker__dropzone");
		expect(zone?.textContent).toBe("Choose image…Drop an image here");
		// The old 28px icon-button class crammed "Choose image…" into a square.
		expect(zone?.classList.contains("icon-picker__action")).toBe(false);
		// Skin-tone / tint rows belong to Emoji / Icon only — Upload has no footer band.
		expect(container.querySelector(".icon-picker__footer")).toBeNull();
		expect(container.querySelector(".icon-picker__search")).toBeNull();
	});

	it("dropping an image uploads it and picks the stored URL", async () => {
		const onChange = vi.fn();
		const onClose = vi.fn();
		const svc = service();
		act(() => {
			root.render(
				<IconPicker
					value={null}
					onChange={onChange}
					onClose={onClose}
					labels={LABELS}
					iconUpload={svc}
				/>,
			);
		});
		clickTab("Upload");
		const zone = container.querySelector<HTMLButtonElement>(".icon-picker__dropzone");
		if (!zone) throw new Error("no drop zone");
		const file = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
		await act(async () => {
			const event = new Event("drop", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
			zone.dispatchEvent(event);
		});
		await flush();
		expect(svc.upload).toHaveBeenCalledWith("logo.png", new Uint8Array([1, 2, 3]));
		expect(onChange).toHaveBeenCalledWith({
			kind: IconKind.Image,
			value: "brainstorm://icon/logo.png",
		});
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("rejects a dropped non-image without touching the store", async () => {
		const onChange = vi.fn();
		const svc = service();
		act(() => {
			root.render(
				<IconPicker
					value={null}
					onChange={onChange}
					onClose={() => {}}
					labels={LABELS}
					iconUpload={svc}
				/>,
			);
		});
		clickTab("Upload");
		const zone = container.querySelector<HTMLButtonElement>(".icon-picker__dropzone");
		if (!zone) throw new Error("no drop zone");
		const file = new File(["hello"], "notes.txt", { type: "text/plain" });
		await act(async () => {
			const event = new Event("drop", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
			zone.dispatchEvent(event);
		});
		await flush();
		expect(svc.upload).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unsupported file");
	});

	it("Library tab says it is loading, then names every uploaded icon", async () => {
		const svc = service([{ url: "brainstorm://icon/a.png", thumbUrl: "thumb:a" }]);
		act(() => {
			root.render(
				<IconPicker
					value={null}
					onChange={() => {}}
					onClose={() => {}}
					labels={LABELS}
					iconUpload={svc}
				/>,
			);
		});
		clickTab("Library");
		expect(container.querySelector(".icon-picker__pending")?.textContent).toBe("Loading library…");
		await flush();
		const cells = container.querySelectorAll(".icon-picker__library-cell");
		expect(cells).toHaveLength(1);
		expect(cells[0]?.getAttribute("aria-label")).toBe("Uploaded icon");
		expect(container.querySelector(".icon-picker__footer")).toBeNull();
	});

	it("without an upload service the Upload tab shows the plain-language placeholder", () => {
		act(() => {
			root.render(<IconPicker value={null} onChange={() => {}} onClose={() => {}} labels={LABELS} />);
		});
		clickTab("Upload");
		expect(container.querySelector(".icon-picker__pending")?.textContent).toBe("Upload pending");
		expect(container.querySelector(".icon-picker__dropzone")).toBeNull();
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

describe("iconUploadFromIcons", () => {
	it("is undefined without a service, so hosts keep the placeholder path", () => {
		expect(iconUploadFromIcons(undefined)).toBeUndefined();
		expect(iconUploadFromIcons(null)).toBeUndefined();
	});

	it("adapts uploadBytes/list and strips the extra entry fields", async () => {
		const bytes = new Uint8Array([1]);
		const icons = {
			uploadBytes: vi.fn(async () => ({ url: "u", thumbUrl: "t" })),
			list: vi.fn(async () => [{ url: "a", thumbUrl: "ta", hash: "h", bytes: 3 }]),
		};
		const adapted = iconUploadFromIcons(icons);
		if (!adapted) throw new Error("expected an adapter");
		await expect(adapted.upload("x.png", bytes)).resolves.toEqual({ url: "u", thumbUrl: "t" });
		expect(icons.uploadBytes).toHaveBeenCalledWith("x.png", bytes);
		await expect(adapted.list()).resolves.toEqual([{ url: "a", thumbUrl: "ta" }]);
	});
});

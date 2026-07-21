import { EMPTY_STYLE_PACK } from "@brainstorm-os/sdk-types";
// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderInto, typeInto } from "../test/render";
import { StylePackEditor } from "./style-pack-editor";

const t = (key: string, params?: Record<string, string>) =>
	params ? `${key}:${Object.values(params).join(",")}` : key;

describe("StylePackEditor", () => {
	it("reports name + css edits and shows the clean state for empty CSS", async () => {
		const onName = vi.fn();
		const onCss = vi.fn();
		const { container, unmount } = await renderInto(
			<StylePackEditor
				pack={{ ...EMPTY_STYLE_PACK }}
				t={t}
				canOpenInCodeEditor={false}
				onName={onName}
				onCss={onCss}
				onOpenInCodeEditor={vi.fn()}
			/>,
		);
		const name = container.querySelector<HTMLInputElement>(".te-stylepack__name");
		const css = container.querySelector<HTMLTextAreaElement>(".te-stylepack__css");
		if (!name || !css) throw new Error("missing fields");
		await typeInto(name, "My pack");
		expect(onName).toHaveBeenCalledWith("My pack");
		expect(container.querySelector(".te-stylepack__problem--ok")).toBeTruthy();
		await unmount();
	});

	it("surfaces validator problems (errors) for unsafe CSS", async () => {
		const { container, unmount } = await renderInto(
			<StylePackEditor
				pack={{ ...EMPTY_STYLE_PACK, css: "@import url(evil.css);" }}
				t={t}
				canOpenInCodeEditor={false}
				onName={vi.fn()}
				onCss={vi.fn()}
				onOpenInCodeEditor={vi.fn()}
			/>,
		);
		expect(container.querySelector(".te-stylepack__problem--error")).toBeTruthy();
		expect(container.querySelector(".te-stylepack__problem--ok")).toBeNull();
		await unmount();
	});

	it("disables Edit-in-Code-Editor until the pack is saved", async () => {
		const onOpen = vi.fn();
		const { container, unmount } = await renderInto(
			<StylePackEditor
				pack={{ ...EMPTY_STYLE_PACK }}
				t={t}
				canOpenInCodeEditor={false}
				onName={vi.fn()}
				onCss={vi.fn()}
				onOpenInCodeEditor={onOpen}
			/>,
		);
		const open = container.querySelector<HTMLButtonElement>(".te-stylepack__open");
		expect(open?.disabled).toBe(true);
		await unmount();
	});

	it("invokes the code-editor handoff when enabled", async () => {
		const onOpen = vi.fn();
		const { container, unmount } = await renderInto(
			<StylePackEditor
				pack={{ ...EMPTY_STYLE_PACK }}
				t={t}
				canOpenInCodeEditor
				onName={vi.fn()}
				onCss={vi.fn()}
				onOpenInCodeEditor={onOpen}
			/>,
		);
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".te-stylepack__open")?.click();
		});
		expect(onOpen).toHaveBeenCalled();
		await unmount();
	});
});

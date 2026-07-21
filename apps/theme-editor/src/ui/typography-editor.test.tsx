import { FontRole, SYSTEM_TYPOGRAPHY, TypographyScale } from "@brainstorm-os/sdk-types";
import { openContextMenu } from "@brainstorm-os/sdk/menus";
// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedTypography } from "../logic/typography-edit";
import { renderInto, typeInto } from "../test/render";
import { TypographyEditor } from "./typography-editor";

vi.mock("@brainstorm-os/sdk/menus", () => ({
	openContextMenu: vi.fn(() => true),
	sdkMenuIcon: vi.fn(() => ({ icon: () => null })),
	blankMenuIcon: { icon: () => null },
}));

const t = (key: string) => key;

afterEach(() => {
	vi.mocked(openContextMenu).mockClear();
});

describe("TypographyEditor", () => {
	it("renders one stack input per font role plus the name field", async () => {
		const { container, unmount } = await renderInto(
			<TypographyEditor
				typo={seedTypography(SYSTEM_TYPOGRAPHY.name)}
				t={t}
				onName={vi.fn()}
				onFontStack={vi.fn()}
				onScale={vi.fn()}
			/>,
		);
		expect(container.querySelectorAll(".te-typo__stack")).toHaveLength(4);
		expect(container.querySelector(".te-typo__name")).toBeTruthy();
		await unmount();
	});

	it("reports a font-stack edit through onFontStack", async () => {
		const onFontStack = vi.fn();
		const { container, unmount } = await renderInto(
			<TypographyEditor
				typo={seedTypography(SYSTEM_TYPOGRAPHY.name)}
				t={t}
				onName={vi.fn()}
				onFontStack={onFontStack}
				onScale={vi.fn()}
			/>,
		);
		const input = container.querySelector<HTMLInputElement>(".te-typo__stack");
		if (!input) throw new Error("no stack input");
		await typeInto(input, "Inter, sans-serif");
		expect(onFontStack).toHaveBeenCalledWith(FontRole.Ui, "Inter, sans-serif");
		await unmount();
	});

	it("opens the density scale via the shared select menu (no native select)", async () => {
		const onScale = vi.fn();
		const { container, unmount } = await renderInto(
			<TypographyEditor
				typo={seedTypography(SYSTEM_TYPOGRAPHY.name)}
				t={t}
				onName={vi.fn()}
				onFontStack={vi.fn()}
				onScale={onScale}
			/>,
		);
		// No native <select> remains.
		expect(container.querySelector("select")).toBeNull();
		const scaleButton = container.querySelector<HTMLButtonElement>(".te-typo__scale");
		expect(scaleButton?.getAttribute("aria-haspopup")).toBe("menu");
		await act(async () => {
			scaleButton?.click();
		});
		expect(openContextMenu).toHaveBeenCalledTimes(1);
		// The menu items map to the scales; activating one fires onScale.
		const [, items] = vi.mocked(openContextMenu).mock.calls[0] ?? [];
		const compact = (items as Array<{ label: string; onSelect?: () => void }>).find(
			(i) => i.label === `scale.${TypographyScale.Compact}`,
		);
		compact?.onSelect?.();
		expect(onScale).toHaveBeenCalledWith(TypographyScale.Compact);
		await unmount();
	});
});

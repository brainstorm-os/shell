import { EMPTY_TOKEN_SET, TokenSetAppearance } from "@brainstorm-os/sdk-types";
import { openColorPicker } from "@brainstorm-os/sdk/color-picker";
// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInto, typeInto } from "../test/render";
import { TokenGrid } from "./token-grid";

vi.mock("@brainstorm-os/sdk/color-picker", () => ({
	openColorPicker: vi.fn(),
}));

const t = (key: string, params?: Record<string, string>) =>
	params ? `${key}:${Object.values(params).join(",")}` : key;

const baseVars = {
	"--color-accent-default": "#3366ff",
	"--space-4": "16px",
};

const groups = [
	{
		section: "Accent",
		rows: [
			{ name: "--color-accent-default", section: "Accent", isColor: true },
			{ name: "--space-4", section: "Accent", isColor: false },
		],
	},
];

afterEach(() => vi.mocked(openColorPicker).mockClear());

function emptySet() {
	return { ...EMPTY_TOKEN_SET, appearance: TokenSetAppearance.Dark };
}

describe("TokenGrid", () => {
	it("renders a swatch only for colour tokens and shows the base value in the input", async () => {
		const { container, unmount } = await renderInto(
			<TokenGrid
				groups={groups}
				baseVars={baseVars}
				set={emptySet()}
				t={t}
				handlers={{ onChange: vi.fn(), onReset: vi.fn() }}
			/>,
		);
		const rows = container.querySelectorAll(".te-row");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.querySelector(".te-row__swatch")).toBeTruthy();
		expect(rows[1]?.querySelector(".te-row__swatch")).toBeNull();
		const firstInput = rows[0]?.querySelector<HTMLInputElement>(".te-row__value");
		expect(firstInput?.value).toBe("#3366ff");
		await unmount();
	});

	it("reports an override edit through onChange", async () => {
		const onChange = vi.fn();
		const { container, unmount } = await renderInto(
			<TokenGrid
				groups={groups}
				baseVars={baseVars}
				set={emptySet()}
				t={t}
				handlers={{ onChange, onReset: vi.fn() }}
			/>,
		);
		const input = container.querySelector<HTMLInputElement>(".te-row__value");
		if (!input) throw new Error("no input");
		await typeInto(input, "#ff0000");
		expect(onChange).toHaveBeenCalledWith("--color-accent-default", "#ff0000");
		await unmount();
	});

	it("clearing the input resets the token", async () => {
		const onReset = vi.fn();
		const { container, unmount } = await renderInto(
			<TokenGrid
				groups={groups}
				baseVars={baseVars}
				set={emptySet()}
				t={t}
				handlers={{ onChange: vi.fn(), onReset }}
			/>,
		);
		const input = container.querySelector<HTMLInputElement>(".te-row__value");
		if (!input) throw new Error("no input");
		await typeInto(input, "   ");
		expect(onReset).toHaveBeenCalledWith("--color-accent-default");
		await unmount();
	});

	it("opens the shared colour picker from the swatch", async () => {
		const { container, unmount } = await renderInto(
			<TokenGrid
				groups={groups}
				baseVars={baseVars}
				set={emptySet()}
				t={t}
				handlers={{ onChange: vi.fn(), onReset: vi.fn() }}
			/>,
		);
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".te-row__swatch")?.click();
		});
		expect(openColorPicker).toHaveBeenCalledTimes(1);
		await unmount();
	});

	it("collapses the reset out of layout on a non-overridden row (input spans full width)", async () => {
		// CSS keys the reset's zero-width collapse off `.te-row--overridden`: a
		// pristine row must NOT carry it, so the value input claims the whole
		// remaining width and no dead space is reserved for the reset.
		const { container, unmount } = await renderInto(
			<TokenGrid
				groups={groups}
				baseVars={baseVars}
				set={emptySet()}
				t={t}
				handlers={{ onChange: vi.fn(), onReset: vi.fn() }}
			/>,
		);
		const row = container.querySelector(".te-row");
		expect(row?.classList.contains("te-row--overridden")).toBe(false);
		// The reset control still renders (markup-stable) but is collapsed by CSS
		// until the row is overridden — the value input is the flex filler.
		expect(row?.querySelector(".te-row__reset")).toBeTruthy();
		expect(row?.querySelector(".te-row__value")).toBeTruthy();
		await unmount();
	});

	it("reveals the reset and fires onReset only once a row is overridden", async () => {
		const onReset = vi.fn();
		const set = { ...emptySet(), overrides: { "--color-accent-default": "#abcdef" } };
		const { container, unmount } = await renderInto(
			<TokenGrid
				groups={groups}
				baseVars={baseVars}
				set={set}
				t={t}
				handlers={{ onChange: vi.fn(), onReset }}
			/>,
		);
		const overridden = container.querySelector(".te-row--overridden");
		const reset = overridden?.querySelector<HTMLButtonElement>(".te-row__reset");
		expect(reset).toBeTruthy();
		await act(async () => {
			reset?.click();
		});
		expect(onReset).toHaveBeenCalledWith("--color-accent-default");
		await unmount();
	});

	it("marks an overridden row and exposes a listbox with a roving cursor", async () => {
		const set = { ...emptySet(), overrides: { "--color-accent-default": "#abcdef" } };
		const { container, unmount } = await renderInto(
			<TokenGrid
				groups={groups}
				baseVars={baseVars}
				set={set}
				t={t}
				handlers={{ onChange: vi.fn(), onReset: vi.fn() }}
			/>,
		);
		expect(container.querySelector(".te-row--overridden")).toBeTruthy();
		const grid = container.querySelector(".te-grid");
		expect(grid?.getAttribute("role")).toBe("listbox");
		const firstOption = container.querySelector(".te-row");
		expect(grid?.getAttribute("aria-activedescendant")).toBe(firstOption?.id);
		await unmount();
	});
});

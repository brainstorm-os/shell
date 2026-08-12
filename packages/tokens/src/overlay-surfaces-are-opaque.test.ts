/**
 * `POLISH-DSN-13 · S3` — an overlay surface must be OPAQUE in every theme.
 *
 * A menu, dialog or popover panel opens over ARBITRARY app content. If its fill
 * lets anything through, whatever happens to be behind it becomes part of the
 * reading surface — and a `saturate()` backdrop-filter over it amplifies the
 * result. The 2026-08-10 fleet audit found three separate instances (the Books
 * Properties panel showing the reader's own paragraph lines, a Files tile icon
 * warming the Sort menu's fill, the dashboard's white widget cards banding
 * through Settings) and the 2026-08-12 re-capture still showed the Files one at
 * a 93%-opaque fill. "Almost opaque" is not a surface.
 *
 * These panels take their fill from a theme token rather than a literal, so the
 * invariant is checkable here as pure arithmetic — the same shape as the
 * contrast ratchet next door, and for the same reason: the defect shipped
 * because nothing ever asserted it.
 *
 * What this CANNOT see, per the audit's own note: a surface that reports an
 * opaque colour while rendering translucent through a `backdrop-filter`, and a
 * full-screen pane with no scrim. Those stay on the screenshot review.
 */

import { describe, expect, it } from "vitest";
import { ThemeName, themes } from "./themes";
import { flattenTokens } from "./tokens";

/** Tokens that are, or are composited directly into, a floating overlay's fill.
 *  A translucent value in any of these puts app content behind menu text. */
const OVERLAY_FILL_TOKENS = [
	// The fancy-menus panel fill (`--fm-surface-bg`), every menu in the product.
	"--color-background-elevated",
] as const;

/** Opaque means: a hex with no alpha channel, or a colour function whose alpha
 *  is exactly 1. `#rrggbbaa` / `#rgba` and any `rgba(… , <1)` are translucent. */
function opacityOf(value: string): number | null {
	const v = value.trim();

	const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
	if (hex?.[1]) {
		const digits = hex[1];
		if (digits.length === 3 || digits.length === 6) return 1;
		if (digits.length === 4) return Number.parseInt(digits[3] as string, 16) / 15;
		if (digits.length === 8) return Number.parseInt(digits.slice(6), 16) / 255;
		return null;
	}

	const fn = /^(rgba?|hsla?)\(([^)]+)\)$/i.exec(v);
	if (fn?.[2]) {
		const body = fn[2];
		// Both spellings carry alpha in a different place: the legacy comma form
		// puts it fourth, the modern space form puts it after a slash. Reading
		// only one of them is how `hsl(0 0% 14% / 60%)` would score as opaque.
		const slash = body.split("/");
		const alpha =
			slash.length > 1
				? (slash[1] as string).trim()
				: (() => {
						const parts = body.split(",").map((p) => p.trim());
						return parts.length >= 4 ? (parts[3] as string) : "1";
					})();
		const n = alpha.endsWith("%") ? Number.parseFloat(alpha) / 100 : Number.parseFloat(alpha);
		return Number.isFinite(n) ? n : null;
	}

	// A var()/color-mix() chain cannot be resolved without a browser. Unevaluable
	// is not a pass: report it so a token that becomes a reference is noticed
	// rather than silently skipped.
	return null;
}

describe("overlay surfaces are opaque — POLISH-DSN-13 S3 ratchet", () => {
	for (const name of Object.values(ThemeName)) {
		it(`${name}: every overlay fill token is fully opaque`, () => {
			const flat = flattenTokens(themes[name]);
			const offenders: string[] = [];

			for (const token of OVERLAY_FILL_TOKENS) {
				const raw = flat[token];
				if (raw === undefined) {
					offenders.push(`${token} is not defined in this theme`);
					continue;
				}
				const alpha = opacityOf(String(raw));
				if (alpha === null) {
					offenders.push(
						`${token} = "${raw}" — not a literal colour, so its alpha is unverifiable here`,
					);
					continue;
				}
				if (alpha < 1) {
					offenders.push(`${token} = "${raw}" — alpha ${alpha}, app content will read through it`);
				}
			}

			expect(offenders).toEqual([]);
		});
	}

	it("the opacity reader itself distinguishes the shapes that matter", () => {
		expect(opacityOf("#232323")).toBe(1);
		expect(opacityOf("#fff")).toBe(1);
		expect(opacityOf("rgb(35, 35, 35)")).toBe(1);
		// The shapes that shipped the defect.
		expect(opacityOf("rgba(255, 255, 255, 0.05)")).toBeCloseTo(0.05);
		expect(opacityOf("#23232380")).toBeCloseTo(0.502, 2);
		expect(opacityOf("hsl(0 0% 14% / 60%)")).toBeCloseTo(0.6);
		// A reference is unevaluable, NOT a pass.
		expect(opacityOf("var(--color-background-elevated)")).toBeNull();
		expect(opacityOf("color-mix(in srgb, #fff 92%, transparent)")).toBeNull();
	});
});

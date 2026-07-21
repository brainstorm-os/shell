// @vitest-environment jsdom

import { CoverKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	COVER_GRADIENTS,
	CoverRenderKind,
	type CoverSubject,
	DEFAULT_COVER_ASPECT,
	ViewCoverMode,
	coverGradientCss,
	coverOf,
	createEntityCoverElement,
	focalToObjectPosition,
	normalizeCoverColor,
	parseCover,
	resolveCoverBackground,
	resolveCoverForView,
	seededGradientKey,
} from "./entity-cover";

const subj = (id: string, cover?: unknown): CoverSubject => ({
	id,
	properties: cover === undefined ? {} : { cover },
});

describe("seededGradientKey", () => {
	it("is deterministic and stable for a given id", () => {
		expect(seededGradientKey("ent_A")).toBe(seededGradientKey("ent_A"));
		expect(seededGradientKey("ent_A")).not.toBe("");
	});

	it("only ever returns a curated gradient key", () => {
		const keys = new Set(Object.keys(COVER_GRADIENTS));
		for (const id of ["a", "ent_01HXYZ", "", "🦊", "Note/v1#42"]) {
			expect(keys.has(seededGradientKey(id))).toBe(true);
		}
	});

	it("spreads across more than one bucket (not a constant)", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 64; i++) seen.add(seededGradientKey(`ent_${i}`));
		expect(seen.size).toBeGreaterThan(1);
	});
});

describe("coverGradientCss", () => {
	it("renders a known curated key", () => {
		expect(coverGradientCss("violet", "seed")).toBe("linear-gradient(135deg, #cdb9f4, #8867d0)");
	});

	it("degrades an unknown key to the id-seeded gradient (never empty)", () => {
		const css = coverGradientCss("not-a-key", "ent_A");
		expect(css).toMatch(/^linear-gradient\(135deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)$/i);
		expect(css).toBe(coverGradientCss(seededGradientKey("ent_A"), "ent_A"));
	});
});

describe("focalToObjectPosition", () => {
	it("centres when focal is absent / malformed", () => {
		expect(focalToObjectPosition(undefined)).toBe("50% 50%");
		expect(focalToObjectPosition({ x: Number.NaN, y: Number.POSITIVE_INFINITY })).toBe(
			"50.00% 50.00%",
		);
	});

	it("maps a 0..1 focal to a percentage position", () => {
		expect(focalToObjectPosition({ x: 0, y: 1 })).toBe("0.00% 100.00%");
		expect(focalToObjectPosition({ x: 0.25, y: 0.75 })).toBe("25.00% 75.00%");
	});

	it("clamps out-of-range focal into [0,1]", () => {
		expect(focalToObjectPosition({ x: -2, y: 9 })).toBe("0.00% 100.00%");
	});
});

describe("coverOf", () => {
	it("returns null for missing / non-object / empty-value covers", () => {
		expect(coverOf(null)).toBeNull();
		expect(coverOf(subj("a"))).toBeNull();
		expect(coverOf(subj("a", "nope"))).toBeNull();
		expect(coverOf(subj("a", { kind: CoverKind.Color, value: "" }))).toBeNull();
		expect(coverOf(subj("a", { kind: "bogus", value: "x" }))).toBeNull();
	});

	it("parses each kind and clamps a malformed image focal", () => {
		expect(coverOf(subj("a", { kind: CoverKind.Color, value: "var(--accent)" }))).toEqual({
			kind: CoverKind.Color,
			value: "var(--accent)",
		});
		expect(coverOf(subj("a", { kind: CoverKind.Gradient, value: "sage" }))).toEqual({
			kind: CoverKind.Gradient,
			value: "sage",
		});
		expect(
			coverOf(
				subj("a", {
					kind: CoverKind.Image,
					value: "brainstorm://cover/x.webp",
					focal: { x: 5, y: -1 },
				}),
			),
		).toEqual({ kind: CoverKind.Image, value: "brainstorm://cover/x.webp", focal: { x: 1, y: 0 } });
		expect(coverOf(subj("a", { kind: CoverKind.Image, value: "brainstorm://cover/u" }))).toEqual({
			kind: CoverKind.Image,
			value: "brainstorm://cover/u",
		});
	});
});

describe("resolveCoverBackground", () => {
	it("null cover → id-seeded gradient paint", () => {
		const r = resolveCoverBackground(subj("ent_A"));
		expect(r.kind).toBe(CoverRenderKind.Paint);
		expect(r).toEqual({
			kind: CoverRenderKind.Paint,
			css: coverGradientCss(seededGradientKey("ent_A"), "ent_A"),
		});
	});

	it("gradient cover → curated css; unknown key degrades to seeded", () => {
		expect(resolveCoverBackground(subj("a", { kind: CoverKind.Gradient, value: "coral" }))).toEqual({
			kind: CoverRenderKind.Paint,
			css: "linear-gradient(135deg, #f5cdb6, #e0815f)",
		});
		const bad = resolveCoverBackground(subj("ent_Z", { kind: CoverKind.Gradient, value: "xxx" }));
		expect(bad).toEqual({
			kind: CoverRenderKind.Paint,
			css: coverGradientCss(seededGradientKey("ent_Z"), "ent_Z"),
		});
	});

	it("color cover → normalized token / literal", () => {
		expect(
			resolveCoverBackground(subj("a", { kind: CoverKind.Color, value: "var(--color-bg)" })),
		).toEqual({ kind: CoverRenderKind.Paint, css: "var(--color-bg)" });
		expect(
			resolveCoverBackground(subj("a", { kind: CoverKind.Color, value: "  --accent " })),
		).toEqual({
			kind: CoverRenderKind.Paint,
			css: "var(--accent)",
		});
		expect(resolveCoverBackground(subj("a", { kind: CoverKind.Color, value: "#1a2b3c" }))).toEqual({
			kind: CoverRenderKind.Paint,
			css: "#1a2b3c",
		});
	});

	it("an unsafe / unrecognised color degrades to the id-seeded gradient (no raw inline-style interpolation)", () => {
		for (const evil of [
			"red; } body{display:none",
			"url(javascript:alert(1))",
			"var(--x, red)",
			"a b",
		]) {
			const r = resolveCoverBackground(subj("ent_A", { kind: CoverKind.Color, value: evil }));
			expect(r).toEqual({
				kind: CoverRenderKind.Paint,
				css: coverGradientCss(seededGradientKey("ent_A"), "ent_A"),
			});
		}
	});

	it("image cover → url + focal position + a precomputed seeded fallback", () => {
		const r = resolveCoverBackground(
			subj("ent_A", {
				kind: CoverKind.Image,
				value: "brainstorm://cover/c.jpg",
				focal: { x: 0.2, y: 0.8 },
			}),
		);
		expect(r).toEqual({
			kind: CoverRenderKind.Image,
			url: "brainstorm://cover/c.jpg",
			position: "20.00% 80.00%",
			fallbackCss: coverGradientCss(seededGradientKey("ent_A"), "ent_A"),
		});
	});

	it("an explicit cover argument overrides the object's properties.cover (per-view override)", () => {
		const s = subj("a", { kind: CoverKind.Color, value: "red" });
		expect(resolveCoverBackground(s, { kind: CoverKind.Gradient, value: "violet" })).toEqual({
			kind: CoverRenderKind.Paint,
			css: "linear-gradient(135deg, #cdb9f4, #8867d0)",
		});
		// Explicit null → fall through to the id-seeded gradient.
		expect(resolveCoverBackground(s, null).kind).toBe(CoverRenderKind.Paint);
		expect((resolveCoverBackground(s, null) as { css: string }).css).toBe(
			coverGradientCss(seededGradientKey("a"), "a"),
		);
	});
});

describe("parseCover", () => {
	it("validates a raw value the same as coverOf (arbitrary-slot reuse contract)", () => {
		expect(parseCover(null)).toBeNull();
		expect(parseCover("nope")).toBeNull();
		expect(parseCover({ kind: CoverKind.Color, value: "" })).toBeNull();
		expect(parseCover({ kind: CoverKind.Gradient, value: "sage" })).toEqual({
			kind: CoverKind.Gradient,
			value: "sage",
		});
		const raw = { kind: CoverKind.Image, value: "brainstorm://cover/u", focal: { x: 9, y: -1 } };
		expect(parseCover(raw)).toEqual(coverOf({ id: "x", properties: { cover: raw } }));
	});

	it("rejects a non-brainstorm Image cover — covers are local, never remote", () => {
		for (const value of [
			"https://attacker.example/track.gif",
			"http://x/y.png",
			"data:image/svg+xml,<svg/>",
			"javascript:alert(1)",
			"//evil.example/a.png",
		]) {
			expect(parseCover({ kind: CoverKind.Image, value })).toBeNull();
		}
		// The local content reference is accepted.
		expect(parseCover({ kind: CoverKind.Image, value: "brainstorm://cover/abc.webp" })).toEqual({
			kind: CoverKind.Image,
			value: "brainstorm://cover/abc.webp",
		});
	});
});

describe("resolveCoverForView", () => {
	it("Inherit (and the default source) → the object's own cover", () => {
		const s = subj("a", { kind: CoverKind.Gradient, value: "coral" });
		const own = resolveCoverBackground(s);
		expect(resolveCoverForView(s, { mode: ViewCoverMode.Inherit })).toEqual(own);
		expect(resolveCoverForView(s)).toEqual(own);
		// No object cover → id-seeded gradient (a paint, never suppressed).
		const r = resolveCoverForView(subj("ent_A"));
		expect(r).toEqual({
			kind: CoverRenderKind.Paint,
			css: coverGradientCss(seededGradientKey("ent_A"), "ent_A"),
		});
	});

	it("Property → the cover at the named key, not properties.cover", () => {
		const s: CoverSubject = {
			id: "ent_A",
			properties: {
				cover: { kind: CoverKind.Color, value: "#000000" },
				heroImage: { kind: CoverKind.Gradient, value: "violet" },
			},
		};
		expect(resolveCoverForView(s, { mode: ViewCoverMode.Property, key: "heroImage" })).toEqual({
			kind: CoverRenderKind.Paint,
			css: "linear-gradient(135deg, #cdb9f4, #8867d0)",
		});
	});

	it("Property with a missing / malformed slot → id-seeded gradient (never a broken square, never suppressed)", () => {
		for (const props of [
			{},
			{ cover: { kind: CoverKind.Gradient, value: "sage" }, hero: "garbage" },
		]) {
			const r = resolveCoverForView(
				{ id: "ent_A", properties: props },
				{
					mode: ViewCoverMode.Property,
					key: "hero",
				},
			);
			expect(r).toEqual({
				kind: CoverRenderKind.Paint,
				css: coverGradientCss(seededGradientKey("ent_A"), "ent_A"),
			});
		}
	});

	it("None → Suppressed (band omitted for this view only — not the seeded gradient)", () => {
		const s = subj("ent_A", { kind: CoverKind.Gradient, value: "coral" });
		expect(resolveCoverForView(s, { mode: ViewCoverMode.None })).toEqual({
			kind: CoverRenderKind.Suppressed,
		});
		// The object still resolves its own cover everywhere else.
		expect(resolveCoverForView(s, { mode: ViewCoverMode.Inherit }).kind).toBe(CoverRenderKind.Paint);
	});
});

describe("normalizeCoverColor", () => {
	it("treats a token shorthand / bare var() as a themed reference", () => {
		expect(normalizeCoverColor("--color-accent")).toEqual({
			css: "var(--color-accent)",
			themed: true,
		});
		expect(normalizeCoverColor("  --color-accent  ")).toEqual({
			css: "var(--color-accent)",
			themed: true,
		});
		expect(normalizeCoverColor("var(--color-accent)")).toEqual({
			css: "var(--color-accent)",
			themed: true,
		});
		expect(normalizeCoverColor("var(  --x_y-2 )")).toEqual({ css: "var(--x_y-2)", themed: true });
	});

	it("passes a recognised literal colour shape through as un-themed", () => {
		for (const lit of [
			"#abc",
			"#aabbcc",
			"#aabbccdd",
			"rgb(1,2,3)",
			"hsl(120 50% 50%)",
			"oklch(0.7 0.1 200)",
			"rebeccapurple",
			"transparent",
			"currentColor",
		]) {
			expect(normalizeCoverColor(lit)).toEqual({ css: lit, themed: false });
		}
	});

	it("rejects non-strings, empty, over-long, and anything that could break out of an inline style", () => {
		for (const bad of [
			null,
			undefined,
			42,
			"",
			"   ",
			`#${"a".repeat(70)}`,
			"red; } body{display:none}",
			"url(http://x)",
			"var(--x, red)", // fallback arg is an injection surface — rejected
			"var(--x);color:red",
			"#xyz",
			"rgb(1,2,3) extra",
			"two tokens",
			"expression(alert(1))",
			"{}",
		]) {
			expect(normalizeCoverColor(bad)).toBeNull();
		}
	});
});

describe("createEntityCoverElement", () => {
	it("paints a gradient cover with no <img> and default aspect", () => {
		const el = createEntityCoverElement(subj("a", { kind: CoverKind.Gradient, value: "sage" }));
		expect(el.dataset.entityCoverKind).toBe("paint");
		expect(el.querySelector("img")).toBeNull();
		expect(el.style.background).toContain("linear-gradient");
		expect(Number.parseFloat(el.style.aspectRatio)).toBeCloseTo(DEFAULT_COVER_ASPECT);
		expect(el.getAttribute("aria-hidden")).toBe("true");
	});

	it("paints the id-seeded gradient for a null cover (never a broken square), deterministically", () => {
		const a = createEntityCoverElement(subj("ent_A"));
		const b = createEntityCoverElement(subj("ent_A"));
		const other = createEntityCoverElement(subj("ent_B"));
		expect(a.dataset.entityCoverKind).toBe("paint");
		expect(a.style.background).toContain("linear-gradient(135deg");
		// Same id → byte-identical background across builds (the "the blue
		// one stays the blue one" invariant); a different id can differ.
		expect(b.style.background).toBe(a.style.background);
		expect(other.style.background).not.toBe("");
	});

	it("renders a lazy image with the focal object-position and honours aspect/radius/className", () => {
		const el = createEntityCoverElement(
			subj("a", {
				kind: CoverKind.Image,
				value: "brainstorm://cover/c.jpg",
				focal: { x: 0.1, y: 0.9 },
			}),
			{ aspect: 3, radius: 8, className: "card__cover" },
		);
		expect(el.dataset.entityCoverKind).toBe("image");
		expect(el.className).toBe("card__cover");
		expect(Number.parseFloat(el.style.aspectRatio)).toBeCloseTo(3);
		expect(el.style.borderRadius).toBe("8px");
		const img = el.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe("brainstorm://cover/c.jpg");
		expect(img?.getAttribute("loading")).toBe("lazy");
		expect(img?.getAttribute("decoding")).toBe("async");
		expect(img?.style.objectFit).toBe("cover");
		expect(img?.style.objectPosition).toBe("10.00% 90.00%");
	});

	it("degrades an image to the id-seeded gradient on load error", () => {
		const el = createEntityCoverElement(
			subj("ent_A", { kind: CoverKind.Image, value: "brainstorm://cover/missing.png" }),
		);
		expect(el.dataset.entityCoverKind).toBe("image");
		el.querySelector("img")?.dispatchEvent(new Event("error"));
		expect(el.dataset.entityCoverKind).toBe("paint");
		expect(el.querySelector("img")).toBeNull();
		// The swapped-in paint is the same id-seeded gradient a null-cover
		// object of the same id would have rendered from the start.
		expect(el.style.background).toBe(createEntityCoverElement(subj("ent_A")).style.background);
		expect(el.style.background).toContain("linear-gradient(135deg");
	});

	it("falls back to the default aspect for a non-positive aspect option", () => {
		const el = createEntityCoverElement(subj("a"), { aspect: 0 });
		expect(Number.parseFloat(el.style.aspectRatio)).toBeCloseTo(DEFAULT_COVER_ASPECT);
	});
});

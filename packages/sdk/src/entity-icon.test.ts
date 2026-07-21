// @vitest-environment jsdom

import { IconKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { createEntityIconElement, parseIcon } from "./entity-icon";

describe("createEntityIconElement", () => {
	it("returns null for a null/undefined icon when no fallback is supplied — no sized empty box", () => {
		// Per [[feedback_no_default_type_icon_fallback]] an unset icon must
		// render NOTHING — no `·` dot, no type-default emoji, AND no sized
		// empty span (project-wide rule, not just DB). Returning null lets
		// the caller's flex/grid layout collapse the gap around the missing
		// slot instead of reserving a fixed icon column.
		for (const input of [null, undefined]) {
			expect(createEntityIconElement(input)).toBeNull();
		}
	});

	it("returns null for a malformed (non-object) icon value with no fallback", () => {
		// Loosely-typed vault data can be anything; the guard must hold.
		expect(createEntityIconElement("emoji" as unknown as null)).toBeNull();
	});

	it("renders an emoji icon as text", () => {
		const el = createEntityIconElement({ kind: IconKind.Emoji, value: "🏙️" });
		expect(el).not.toBeNull();
		expect(el?.dataset.entityIconKind).toBe("emoji");
		expect(el?.textContent).toBe("🏙️");
	});

	it("pins a colour-emoji font so the codepoint never inherits a non-emoji app stack", () => {
		const el = createEntityIconElement({ kind: IconKind.Emoji, value: "📓" });
		expect(el).not.toBeNull();
		expect(el?.style.fontFamily).toMatch(/Apple Color Emoji/);
		expect(el?.style.fontFamily).toMatch(/Segoe UI Emoji/);
		expect(el?.style.fontFamily).toMatch(/Noto Color Emoji/);
	});

	it("wraps the emoji codepoint in an inline-block nudged down so its visual centre lines up with pack-glyph SVGs (regression: emoji sat above row centre vs Phosphor icons in Database sidebar)", () => {
		const el = createEntityIconElement({ kind: IconKind.Emoji, value: "😍" });
		expect(el).not.toBeNull();
		const inner = el?.firstElementChild as HTMLElement | null;
		expect(inner).not.toBeNull();
		expect(inner?.tagName).toBe("SPAN");
		expect(inner?.style.display).toBe("inline-block");
		expect(inner?.style.transform).toMatch(/translateY/);
		// textContent still reports the codepoint (it traverses descendants),
		// so existing consumers reading textContent are unaffected.
		expect(el?.textContent).toBe("😍");
	});

	it("returns null when an emoji icon carries an empty value and no fallback", () => {
		expect(createEntityIconElement({ kind: IconKind.Emoji, value: "" })).toBeNull();
	});

	it("renders an image icon and hides the wrap on load error (no fallback) so the gap collapses", () => {
		// The wrap is already in the surrounding DOM by the time the image
		// fails, so we can't retroactively return null — instead the wrap
		// is hidden (`display: none`) so flex/grid gap around the missing
		// slot collapses.
		const el = createEntityIconElement(
			{ kind: IconKind.Image, value: "https://example.test/a.png" },
			{ size: 24 },
		);
		expect(el).not.toBeNull();
		const wrap = el as HTMLElement;
		expect(wrap.dataset.entityIconKind).toBe("image");
		const img = wrap.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe("https://example.test/a.png");
		expect(img?.style.width).toBe("24px");

		img?.dispatchEvent(new Event("error"));
		expect(wrap.dataset.entityIconKind).toBe("fallback");
		expect(wrap.querySelector("img")).toBeNull();
		expect(wrap.textContent).toBe("");
		expect(wrap.style.display).toBe("none");
	});

	it("returns null for a pack icon with no fallback (DOM apps don't bundle Phosphor)", () => {
		expect(createEntityIconElement({ kind: IconKind.Pack, value: "phosphor/user" })).toBeNull();
	});

	it("uses a caller-supplied fallback node and the requested size", () => {
		const el = createEntityIconElement(null, {
			size: 32,
			fallback: () => {
				const s = document.createElement("span");
				s.textContent = "TYPE";
				return s;
			},
		});
		expect(el).not.toBeNull();
		const wrap = el as HTMLElement;
		expect(wrap.dataset.entityIconKind).toBe("fallback");
		expect(wrap.textContent).toBe("TYPE");
		expect(wrap.style.width).toBe("32px");
		expect(wrap.style.fontSize).toBe("28px"); // round(32 * 0.86)
	});
});

describe("parseIcon", () => {
	it("returns null for absent / non-object blobs", () => {
		for (const raw of [null, undefined, "", "emoji", 42, true, []]) {
			expect(parseIcon(raw)).toBeNull();
		}
	});

	it("returns null for an unknown kind or an empty/non-string value", () => {
		expect(parseIcon({ kind: "bogus", value: "x" })).toBeNull();
		expect(parseIcon({ kind: IconKind.Emoji, value: "" })).toBeNull();
		expect(parseIcon({ kind: IconKind.Emoji })).toBeNull();
		expect(parseIcon({ kind: IconKind.Emoji, value: 5 })).toBeNull();
		expect(parseIcon({ value: "no-kind" })).toBeNull();
	});

	it("parses an emoji icon", () => {
		expect(parseIcon({ kind: "emoji", value: "🌧️" })).toEqual({
			kind: IconKind.Emoji,
			value: "🌧️",
		});
	});

	it("parses a privileged brainstorm:// image icon", () => {
		expect(parseIcon({ kind: "image", value: "brainstorm://icon/abc.png" })).toEqual({
			kind: IconKind.Image,
			value: "brainstorm://icon/abc.png",
		});
	});

	it("rejects a non-brainstorm image scheme (cross-app img.src beacon guard)", () => {
		for (const value of [
			"https://attacker.example/track.gif",
			"http://x/y.png",
			"data:image/svg+xml,<svg/>",
			"javascript:alert(1)",
			"file:///etc/passwd",
			"//evil.example/a.png",
		]) {
			expect(parseIcon({ kind: "image", value })).toBeNull();
		}
	});

	it("parses a pack icon, keeping a valid colour and dropping a non-string one", () => {
		expect(parseIcon({ kind: "pack", value: "phosphor/user", color: "#e8b339" })).toEqual({
			kind: IconKind.Pack,
			value: "phosphor/user",
			color: "#e8b339",
		});
		expect(parseIcon({ kind: "pack", value: "phosphor/user", color: 123 })).toEqual({
			kind: IconKind.Pack,
			value: "phosphor/user",
		});
		expect(parseIcon({ kind: "pack", value: "phosphor/user" })).toEqual({
			kind: IconKind.Pack,
			value: "phosphor/user",
		});
	});

	it("ignores extra unknown properties", () => {
		expect(parseIcon({ kind: "emoji", value: "🚀", evil: "<script>" })).toEqual({
			kind: IconKind.Emoji,
			value: "🚀",
		});
	});
});

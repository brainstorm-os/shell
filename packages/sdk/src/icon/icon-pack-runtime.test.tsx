// @vitest-environment jsdom
/**
 * IconPack/v1 render-application (Stage 8.6): the runtime cache, the
 * `useIcon` reactive seam, and the override path in both renderers. The
 * built-in Phosphor base stays the default (no pack) — proven by the
 * "restores built-in" cases — so the 11 apps are unaffected until a
 * pack is installed.
 */
import { type IconPackDef, IconPackStyle } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIconElement } from "./create-icon-element";
import { Icon } from "./icon";
import {
	getActiveIconPack,
	getIconPackEpoch,
	resolveIconOverride,
	setActiveIconPack,
	subscribeIconPack,
} from "./icon-pack-runtime";
import { IconName } from "./icon-registry";

const SETTINGS_SVG = '<rect width="10" height="10" data-pack="A" />';
const FALLBACK_SVG = '<circle r="5" data-pack="fallback" />';

function pack(icons: Record<string, string>, fallback = ""): IconPackDef {
	return {
		name: "Test pack",
		version: "1.0.0",
		license: "MIT",
		metadata: { style: IconPackStyle.Line },
		icons: Object.fromEntries(Object.entries(icons).map(([k, svg]) => [k, { svg }])),
		fallback,
	};
}

// Process-global state — never leak a pack into sibling cases / suites.
afterEach(() => setActiveIconPack(null));

describe("icon-pack-runtime", () => {
	it("defaults to no pack — override is null, built-in base wins", () => {
		expect(getActiveIconPack()).toBeNull();
		expect(resolveIconOverride(IconName.Settings)).toBeNull();
	});

	it("returns the pack glyph for an overridden name, null for an absent one", () => {
		setActiveIconPack(pack({ [IconName.Settings]: SETTINGS_SVG }));
		expect(resolveIconOverride(IconName.Settings)).toBe(SETTINGS_SVG);
		expect(resolveIconOverride(IconName.Trash)).toBeNull(); // not in pack, no fallback
	});

	it("uses the pack's declared fallback when a name is absent", () => {
		setActiveIconPack(pack({ generic: FALLBACK_SVG }, "generic"));
		expect(resolveIconOverride(IconName.Trash)).toBe(FALLBACK_SVG);
	});

	it("bumps the epoch and invalidates the cache on every swap", () => {
		const e0 = getIconPackEpoch();
		setActiveIconPack(pack({ [IconName.Settings]: SETTINGS_SVG }));
		expect(getIconPackEpoch()).not.toBe(e0);
		expect(resolveIconOverride(IconName.Settings)).toBe(SETTINGS_SVG); // caches
		setActiveIconPack(pack({ [IconName.Settings]: '<path data-pack="B" />' }));
		// Cache must NOT return the stale A markup after the swap.
		expect(resolveIconOverride(IconName.Settings)).toBe('<path data-pack="B" />');
		setActiveIconPack(null);
		expect(resolveIconOverride(IconName.Settings)).toBeNull();
	});

	it("notifies subscribers on swap and stops after unsubscribe", () => {
		let hits = 0;
		const off = subscribeIconPack(() => hits++);
		setActiveIconPack(pack({ [IconName.Settings]: SETTINGS_SVG }));
		setActiveIconPack(null);
		expect(hits).toBe(2);
		off();
		setActiveIconPack(pack({ [IconName.Settings]: SETTINGS_SVG }));
		expect(hits).toBe(2); // no further notifications
	});
});

describe("createIconElement honours an active IconPack", () => {
	it("paints the override markup when a pack supplies the name", () => {
		setActiveIconPack(pack({ [IconName.Settings]: SETTINGS_SVG }));
		const el = createIconElement(IconName.Settings, { size: 20 }) as SVGSVGElement;
		expect(el.tagName.toLowerCase()).toBe("svg");
		expect(el.getAttribute("width")).toBe("20");
		expect(el.getAttribute("viewBox")).toBe("0 0 256 256");
		// Override markup is injected (jsdom re-serialises self-closing
		// tags, so assert the element, not an exact string).
		const rect = el.querySelector("rect");
		expect(rect?.getAttribute("data-pack")).toBe("A");
	});

	it("falls back to the built-in glyph when no pack / name absent", () => {
		const builtIn = createIconElement(IconName.Settings) as SVGSVGElement;
		expect(builtIn.querySelector("path")).not.toBeNull(); // Phosphor path, unchanged
	});
});

describe("<Icon> + useIcon react to pack installs live", () => {
	let host: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	it("renders the built-in glyph, then the override after setActiveIconPack", () => {
		act(() => root.render(<Icon name={IconName.Settings} size={18} />));
		// Built-in: Phosphor component renders a path; no pack marker.
		expect(host.querySelector("svg [data-pack]")).toBeNull();

		act(() => setActiveIconPack(pack({ [IconName.Settings]: SETTINGS_SVG })));
		const svg = host.querySelector("svg");
		expect(svg?.getAttribute("width")).toBe("18");
		expect(svg?.querySelector("[data-pack]")).not.toBeNull();

		act(() => setActiveIconPack(null));
		expect(host.querySelector("svg [data-pack]")).toBeNull(); // back to built-in
	});
});

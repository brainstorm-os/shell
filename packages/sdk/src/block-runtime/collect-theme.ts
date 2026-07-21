/**
 * Host-side theme harvest for BP block embeds (the answer to a block's
 * `ThemeRequest`). The block iframe is its own origin, so the host must
 * ship the live token values across the transport.
 *
 * The original harvest iterated only `documentElement.style` — but in app
 * renderers the theme tokens live in STYLESHEETS (`@brainstorm-os/sdk`'s
 * app-theme + the tokens css), not inline, so blocks received exactly the
 * three preload header-padding vars and painted with their light fallbacks
 * inside dark themes (F-210). This collector reads COMPUTED values:
 * custom-property names are discovered from (1) the inline declaration,
 * (2) computed-style enumeration (Chromium lists registered + applied
 * custom properties), and (3) a same-origin stylesheet walk as the jsdom /
 * older-engine fallback — then each name resolves through
 * `getComputedStyle(root).getPropertyValue(...)` so cascade and theme
 * switches are honoured without coupling to a token list.
 */

const CUSTOM_PROP_RE = /--[a-zA-Z0-9_-]+/g;

function discoverCustomPropertyNames(win: Window & typeof globalThis): Set<string> {
	const names = new Set<string>();
	const root = win.document.documentElement;
	const inline = root.style;
	for (let i = 0; i < inline.length; i += 1) {
		const key = inline.item(i);
		if (key.startsWith("--")) names.add(key);
	}
	const computed = win.getComputedStyle(root);
	for (let i = 0; i < computed.length; i += 1) {
		const key = computed.item(i);
		if (key.startsWith("--")) names.add(key);
	}
	// Stylesheet walk — covers engines whose computed enumeration omits
	// custom properties. Cross-origin sheets throw on `cssRules`; skip them.
	for (const sheet of Array.from(win.document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue;
		}
		for (const rule of Array.from(rules)) {
			const text = (rule as CSSStyleRule).cssText ?? "";
			if (!text.includes("--")) continue;
			for (const match of text.matchAll(CUSTOM_PROP_RE)) {
				names.add(match[0]);
			}
		}
	}
	return names;
}

/** Resolve a usable `color-scheme` for the block document. The computed
 *  host value is often the unresolved pair ("light dark"), which would let
 *  the iframe fall back to the OS preference even when the app theme is
 *  dark — so when the primary background token is parseable, its luminance
 *  decides. */
function resolveColorScheme(win: Window & typeof globalThis, bg: string): string {
	const hex = bg.match(/^#([0-9a-fA-F]{6})$/)?.[1];
	if (hex) {
		const r = Number.parseInt(hex.slice(0, 2), 16);
		const g = Number.parseInt(hex.slice(2, 4), 16);
		const b = Number.parseInt(hex.slice(4, 6), 16);
		return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? "dark" : "light";
	}
	return win.getComputedStyle(win.document.documentElement).colorScheme || "normal";
}

export function collectBlockThemeVars(win: Window & typeof globalThis = window): {
	vars: Record<string, string>;
	colorScheme: string;
} {
	const root = win.document.documentElement;
	const computed = win.getComputedStyle(root);
	const vars: Record<string, string> = {};
	for (const name of discoverCustomPropertyNames(win)) {
		const value = computed.getPropertyValue(name).trim();
		if (value) vars[name] = value;
	}
	const colorScheme = resolveColorScheme(win, vars["--color-background-primary"] ?? "");
	return { vars, colorScheme };
}

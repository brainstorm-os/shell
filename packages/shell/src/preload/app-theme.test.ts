import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gradientFor } from "@brainstorm-os/protocol/app-icon-palette";
import { describe, expect, it } from "vitest";
import { APP_THEME_STYLE_ID, appIconVarPairs, buildAppIconVarsCss } from "./app-theme";

const SDK_APP_THEME_CSS = readFileSync(
	resolve(__dirname, "../../../sdk/src/app-theme.css"),
	"utf8",
);

describe("app-theme — runtime per-app icon vars (preload-side)", () => {
	it("exports the stable style-element id used by app-preload", () => {
		expect(APP_THEME_STYLE_ID).toBe("brainstorm-app-theme");
	});

	it("emits the four :root custom properties keyed on the app id", () => {
		const css = buildAppIconVarsCss("io.example.notes");
		const g = gradientFor("io.example.notes");
		expect(css).toContain(":root {");
		expect(css).toContain('--app-icon-image: url("brainstorm://app-icon/io.example.notes");');
		expect(css).toContain(`--app-icon-grad-from: ${g.from};`);
		expect(css).toContain(`--app-icon-grad-to: ${g.to};`);
		expect(css).toContain(`--app-icon-ink: ${g.ink};`);
	});

	it("differs per app id (chip is deterministic per app)", () => {
		expect(buildAppIconVarsCss("io.example.notes")).not.toBe(buildAppIconVarsCss("io.example.tasks"));
	});

	it("returns the same four values as inline-var pairs for documentElement.style", () => {
		const pairs = appIconVarPairs("io.example.notes");
		expect(pairs).toHaveLength(4);
		expect(Object.fromEntries(pairs)).toMatchObject({
			"--app-icon-image": 'url("brainstorm://app-icon/io.example.notes")',
			"--app-icon-grad-from": gradientFor("io.example.notes").from,
			"--app-icon-grad-to": gradientFor("io.example.notes").to,
			"--app-icon-ink": gradientFor("io.example.notes").ink,
		});
	});
});

describe("@brainstorm-os/sdk/app-theme.css — build-time component sheet", () => {
	const css = SDK_APP_THEME_CSS;

	it("binds every alias to a canonical --color-* / --shadow-* token", () => {
		expect(css).toContain("--accent: var(--color-accent-default);");
		expect(css).toContain("--accent-strong: var(--color-accent-strong);");
		expect(css).toContain("--accent-fg: var(--color-accent-text);");
		expect(css).toContain("--bg: var(--color-background-primary);");
		expect(css).toContain("--text: var(--color-text-primary);");
		expect(css).toContain("--border: var(--color-border-subtle);");
		expect(css).toContain("--shadow-popover: var(--shadow-lg);");
	});

	it("resolves the latent per-app drift to the correct token", () => {
		// text.secondary === text.primary in the design tokens, so "dim"
		// must map to tertiary to actually read as dimmed.
		expect(css).toContain("--text-dim: var(--color-text-tertiary);");
		// `--color-accent-soft` is not a real token — the real one is the
		// accent subtle. The old per-app blocks all silently fell back.
		expect(css).toContain("--accent-soft: var(--color-accent-subtle);");
		expect(css).not.toContain("--color-accent-soft");
	});

	it("ships the shared find-bar chrome (B9.1c — apps style nothing)", () => {
		expect(css).toContain(":root .bs-find-bar {");
		expect(css).toContain(":root .bs-find-bar__input:focus-visible {");
		expect(css).toContain('.bs-find-bar__toggle[aria-pressed="true"]');
		expect(css).toContain("background: var(--bg-elev);");
		// never un-prefixed
		expect(css).not.toContain("\n.bs-find-bar {");
	});

	it("renders the per-app icon chip via custom properties (preload pushes the values)", () => {
		expect(css).toContain(":root .app-header__icon {");
		expect(css).toContain("var(--app-icon-image");
		expect(css).toContain("var(--app-icon-grad-from");
		expect(css).toContain("var(--app-icon-grad-to");
		expect(css).toContain("var(--app-icon-ink");
	});

	it("carries no raw fallback hexes — token-bound everywhere", () => {
		// Strip the white speculars in the icon-chip ::after gradient
		// (intentional opaque-white sheen, not a theme value), then assert
		// nothing else carries a hex literal.
		const withoutSpeculars = css.replace(/rgba\(255, 255, 255[^)]*\)/g, "");
		const withoutDropShadow = withoutSpeculars.replace(/rgba\(9, 12, 60[^)]*\)/g, "");
		const withoutDropShadow2 = withoutDropShadow.replace(/rgba\(0, 0, 0[^)]*\)/g, "");
		expect(withoutDropShadow2).not.toMatch(/#[0-9a-fA-F]{6}/);
	});

	it("glosses every primary button from one place via the data-bs-primary hook", () => {
		for (const cls of [
			"[data-bs-primary]",
			".notes__btn--primary",
			".notes__inline-toolbar-btn--primary",
		]) {
			expect(css).toContain(cls);
			expect(css).toContain(`${cls}:hover:not(:disabled)`);
		}
	});

	it("ships the shared .bs-btn structural primitive with its size + surface modifiers", () => {
		for (const cls of [
			".bs-btn",
			".bs-btn--sm",
			".bs-btn--lg",
			".bs-btn--secondary",
			".bs-btn--neutral",
			".bs-btn--ghost",
			".bs-btn--danger",
			".bs-btn--icon",
		]) {
			expect(css).toContain(cls);
		}
	});

	it("uses the 2-colour gloss tokens, not a single accent or a white band", () => {
		expect(css).toContain(
			"linear-gradient(to bottom, var(--color-gloss-top), var(--color-gloss-bottom))",
		);
		expect(css).toContain("var(--color-gloss-shine-top)");
		expect(css).toContain("var(--color-gloss-shine-bottom)");
		expect(css).toContain("var(--color-gloss-inner-top)");
		// No white-to-clear top sheen band (the old "white on top" bug).
		expect(css).not.toContain("rgba(255, 255, 255, 0.45)");
	});

	it("animates the hover (box-shadow + lift + specular bloom) on the motion tokens", () => {
		expect(css).toContain("box-shadow var(--motion-duration-slow)");
		expect(css).toContain("var(--motion-easing-decelerated)");
		expect(css).toContain("transform: translateY(-1px);");
	});

	it("includes the glass utilities and the header-icon gloss", () => {
		expect(css).toContain(".glass--strong { background: var(--color-glass-background-strong); }");
		expect(css).toContain(".app-header__icon::after");
	});

	it("owns the shared in-app back/forward control chrome (identical in every app)", () => {
		expect(css).toContain(":root .header-nav {");
		expect(css).toContain(":root .header-nav__btn {");
		expect(css).toContain("width: 26px;");
		expect(css).toContain(":root .header-nav__btn:hover:not(:disabled) {");
		expect(css).toContain(":root .header-nav__btn:disabled {");
		// Inset focus ring — the project's no-"sandwich" focus convention.
		expect(css).toContain("outline-offset: -2px;");
	});

	it("suppresses transitions while the body carries the .is-resizing drag flag", () => {
		expect(css).toContain("body.is-resizing,");
		expect(css).toContain("body.is-resizing *,");
		expect(css).toContain("body.is-resizing *::before,");
		expect(css).toContain("body.is-resizing *::after");
		expect(css).toContain("transition-duration: 0s !important;");
	});

	it("owns the .app-header drag-region opt-outs for shared chrome classes", () => {
		expect(css).toContain(":root .app-header {");
		expect(css).toContain("-webkit-app-region: drag;");
		expect(css).toContain(":root .app-header button,");
		expect(css).toContain(':root .app-header [role="button"],');
		expect(css).toContain(":root .app-header .header-nav,");
		expect(css).toContain(":root .app-header .bs-icon-pick,");
		expect(css).toContain(":root .app-header .bs-object-menu__more,");
		expect(css).toContain(":root .app-header .bs-panel-toggle {");
		expect(css).toContain("-webkit-app-region: no-drag;");
	});

	it("owns the shared object-icon picker affordance (transparent until hover)", () => {
		expect(css).toContain(":root .bs-icon-pick {");
		expect(css).toContain("background: transparent;");
		expect(css).toContain(":root .bs-icon-pick:hover:not(:disabled) { background: var(--hover); }");
		expect(css).toContain(".bs-icon-pick__add { opacity: 0.45; }");
		expect(css).toContain(".bs-icon-pick:hover:not(:disabled) .bs-icon-pick__add { opacity: 0.8; }");
	});
});

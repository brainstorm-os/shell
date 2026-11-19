/**
 * `themeToCss` — the published site's one stylesheet: the theme's flattened
 * design tokens as custom properties, plus a small typographic base binding
 * the exported semantic HTML to them. No fonts, images or imports — the site
 * loads nothing it does not carry.
 */

const TOKEN_NAME = /^--[a-z0-9]+(-[a-z0-9]+)*$/;
/** A value that could end the declaration, open a rule, or reach outside the
 *  site (`url(…)`, an escape that spells one). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting controls is the point
const UNSAFE_TOKEN_VALUE = /[;{}<>\\@\u0000-\u001f]|url\s*\(|expression\s*\(|\/\*/i;

const BASE_CSS = `*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
	margin: 0;
	background: var(--color-background-primary, #ffffff);
	color: var(--color-text-primary, #1a1a1a);
	font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	font-size: 1.0625rem;
	line-height: 1.65;
}
.site-header, main, .site-pages { max-width: 42rem; margin: 0 auto; padding: 0 1.25rem; }
.site-header { padding-top: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--color-border-subtle, #e5e5e5); }
.site-title { color: var(--color-text-secondary, #555555); font-weight: 600; text-decoration: none; }
main { padding-top: 2rem; padding-bottom: 3rem; overflow-wrap: break-word; }
.site-pages { padding-bottom: 4rem; }
.site-pages h2 { font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-text-secondary, #555555); }
.site-pages ul { list-style: none; padding: 0; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2em 0 0.5em; }
h1 { font-size: 2.25rem; margin-top: 0; }
h2 { font-size: 1.625rem; }
h3 { font-size: 1.3125rem; }
h4, h5, h6 { font-size: 1.0625rem; }
p, ul, ol, blockquote, pre, figure, table { margin: 0 0 1.1em; }
a { color: var(--color-text-link, #1a5fd0); }
blockquote { padding-left: 1em; border-left: 3px solid var(--color-border-default, #cccccc); color: var(--color-text-secondary, #555555); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
code { background: var(--color-background-subtle, #f2f2f2); padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: var(--color-background-subtle, #f2f2f2); padding: 1em; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; }
img { max-width: 100%; height: auto; border-radius: 8px; }
figure { margin-left: 0; margin-right: 0; }
figcaption { color: var(--color-text-secondary, #555555); font-size: 0.875em; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--color-border-default, #cccccc); padding: 0.4em 0.6em; text-align: left; vertical-align: top; }
hr { border: 0; border-top: 1px solid var(--color-border-subtle, #e5e5e5); margin: 2em 0; }
`;

export function themeToCss(tokens: Readonly<Record<string, string>>): string {
	const lines = Object.entries(tokens)
		.filter(([name, value]) => TOKEN_NAME.test(name) && !UNSAFE_TOKEN_VALUE.test(value))
		.map(([name, value]) => `\t${name}: ${value.trim()};`);
	return `:root {\n${lines.join("\n")}\n}\n${BASE_CSS}`;
}

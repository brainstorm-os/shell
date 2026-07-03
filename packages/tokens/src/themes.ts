/**
 * Built-in themes. Per §Themes — Brainstorm
 * ships light / dark token sets plus a small set of opinionated variants
 * (Midnight, Sepia, High Contrast). Third-party theme bundles install
 * through the same package format (`manifest.kind: "theme"`) once the theme
 * store lands.
 *
 * The structure is intentionally flat — every theme is a full Tokens object
 * so token consumers never have to merge defaults at runtime. Shared
 * non-color sections (space, radius, motion, text, z, glass) live as module
 * constants so the diff between variants stays focused on color.
 */

import type { Tokens } from "./tokens";

const palette = {
	// Truly neutral grey scale — no blue undertone. Surfaces read as glass /
	// stone; the brand mark + accent keep the blue identity. The dark-mode
	// surfaces (700/800) are lifted from near-black so panels read as a real
	// mid-grey rather than a void.
	gray: {
		"50": "#f7f7f7",
		"100": "#ededed",
		"200": "#d4d4d4",
		"300": "#a8a8a8",
		"400": "#7a7a7a",
		"500": "#5a5a5a",
		"600": "#424242",
		"700": "#303030",
		"800": "#232323",
		"900": "#161616",
		"950": "#0a0a0a",
	},
	// Accent palette — a refined violet-indigo that pairs better with the
	// aerial frosted glass surfaces than the previous cyan-leaning blue.
	blue: {
		"300": "#a8b2ff",
		"400": "#8b95ff",
		"500": "#6b73f0",
		"600": "#5b62e0",
	},
	green: {
		"400": "#4ade80",
		"600": "#16a34a",
	},
	amber: {
		"400": "#fbbf24",
		"600": "#d97706",
	},
	red: {
		"400": "#f87171",
		"600": "#dc2626",
	},
	cyan: {
		"400": "#22d3ee",
		"600": "#0891b2",
	},
} as const;

const fontFamilies = {
	ui: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
	body: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
	code: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
	display: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
} as const;

const serifFontFamilies = {
	ui: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
	body: 'ui-serif, Georgia, "Iowan Old Style", "Apple Garamond", serif',
	code: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
	display: 'ui-serif, Georgia, "Iowan Old Style", "Apple Garamond", serif',
} as const;

const space = {
	"0": "0px",
	"0_5": "2px",
	"1": "4px",
	"2": "8px",
	"3": "12px",
	"4": "16px",
	"5": "24px",
	"6": "32px",
	"7": "48px",
	"8": "64px",
} as const;

// Even-pixel scale — sub-pixel hinting on macOS / ChromeOS antialiases
// even values more cleanly than odd ones, so every step is even. `xs`
// collapses onto `sm` (both 12px) because the previous 11px tier read
// as too small in every surface that used it; the alias is kept so
// existing `--text-size-xs` consumers don't break.
const textSize = {
	xs: "12px",
	sm: "12px",
	md: "14px",
	lg: "16px",
	xl: "18px",
	"2xl": "22px",
	"3xl": "32px",
	display: "48px",
} as const;

const textWeight = {
	regular: "400",
	medium: "500",
	semibold: "600",
	bold: "700",
} as const;

const textLineHeight = {
	tight: "1.2",
	normal: "1.5",
	relaxed: "1.7",
} as const;

const control = {
	height: {
		sm: "24px",
		md: "32px",
		lg: "40px",
	},
} as const;

const radius = {
	none: "0",
	// The scale follows a 2 / 4 / 8 / 12 step (+ 16 for the rare large surface).
	// `sm` is the product's de-facto default radius (rows, chips, inputs, menus)
	// — 4px, tight and consistent. `xs` (2px) is for genuinely tiny corners
	// (checkbox inner, selection wash); `md`/`lg` are cards and panels.
	xs: "2px",
	sm: "4px",
	md: "8px",
	lg: "12px",
	xl: "16px",
	full: "9999px",
} as const;

// Stroke widths. `width` is the default hairline used by every panel / row /
// chip / input border; `thick` is the emphasis weight (active rails, stronger
// dividers). Tokenised so the whole product's border weight tunes from here.
const border = {
	width: "1px",
	widthThick: "2px",
} as const;

const motion = {
	duration: {
		instant: "0ms",
		fast: "100ms",
		normal: "200ms",
		slow: "400ms",
		deliberate: "700ms",
	},
	easing: {
		linear: "linear",
		standard: "cubic-bezier(0.4, 0, 0.2, 1)",
		emphasized: "cubic-bezier(0.2, 0, 0, 1)",
		decelerated: "cubic-bezier(0, 0, 0.2, 1)",
	},
} as const;

const z = {
	base: "0",
	dropdown: "10",
	sticky: "20",
	overlay: "30",
	modal: "40",
	popover: "50",
	toast: "60",
	commandPalette: "70",
	windowControlsOverlay: "80",
} as const;

// Graph subject palettes — eight categorical hues per theme, picked for
// distinguishability against the theme's background and against one another.
// The graph app renders nodes as tinted-fill + saturated-stroke discs; both
// surfaces read these tokens so the palette only needs to be defined once
// per theme. Matched edges take the accent; unmatched edges fade to a tinted
// grey. Edges and unmatched nodes are intentionally calmer than the eight
// subject hues so subject identity reads first.
const graphDark = {
	subject: {
		"1": "#a78bfa", // violet
		"2": "#60a5fa", // blue
		"3": "#34d399", // emerald
		"4": "#fbbf24", // amber
		"5": "#f87171", // rose
		"6": "#22d3ee", // cyan
		"7": "#f472b6", // pink
		"8": "#a3e635", // lime
	},
	unmatched: "rgba(180, 190, 210, 0.45)",
	edge: {
		matched: "rgba(168, 162, 255, 0.7)",
		unmatched: "rgba(180, 190, 210, 0.3)",
	},
} as const;

const graphLight = {
	subject: {
		"1": "#7c3aed",
		"2": "#2563eb",
		"3": "#059669",
		"4": "#d97706",
		"5": "#dc2626",
		"6": "#0891b2",
		"7": "#db2777",
		"8": "#65a30d",
	},
	unmatched: "rgba(100, 116, 139, 0.45)",
	edge: {
		matched: "rgba(91, 98, 224, 0.65)",
		unmatched: "rgba(100, 116, 139, 0.3)",
	},
} as const;

const graphMidnight = {
	subject: {
		"1": "#7dd3fc",
		"2": "#a5b4fc",
		"3": "#67e8f9",
		"4": "#facc15",
		"5": "#fb7185",
		"6": "#5eead4",
		"7": "#c4b5fd",
		"8": "#bef264",
	},
	unmatched: "rgba(180, 200, 255, 0.4)",
	edge: {
		matched: "rgba(56, 189, 248, 0.7)",
		unmatched: "rgba(180, 200, 255, 0.28)",
	},
} as const;

const graphSepia = {
	subject: {
		"1": "#b04a18", // terracotta
		"2": "#6b8e23", // olive
		"3": "#bf8b30", // ochre
		"4": "#7d2d1a", // brick
		"5": "#a07a4a", // tan
		"6": "#3f7458", // sage
		"7": "#7a4a2a", // walnut
		"8": "#8a4a8a", // plum
	},
	unmatched: "rgba(90, 70, 40, 0.42)",
	edge: {
		matched: "rgba(176, 74, 24, 0.65)",
		unmatched: "rgba(90, 70, 40, 0.28)",
	},
} as const;

const graphHighContrast = {
	subject: {
		"1": "#ffd400", // yellow
		"2": "#00e5ff", // cyan
		"3": "#ff00ff", // magenta
		"4": "#00ff7f", // green
		"5": "#ff5252", // red
		"6": "#ffffff", // white
		"7": "#ffa726", // orange
		"8": "#82b1ff", // blue
	},
	unmatched: "rgba(255, 255, 255, 0.55)",
	edge: {
		matched: "#ffd400",
		unmatched: "rgba(255, 255, 255, 0.4)",
	},
} as const;

const graphSolar = {
	subject: {
		"1": "#ea580c", // orange
		"2": "#ca8a04", // gold
		"3": "#16a34a", // green
		"4": "#0891b2", // cyan
		"5": "#4f46e5", // indigo
		"6": "#db2777", // pink
		"7": "#65a30d", // olive
		"8": "#be123c", // crimson
	},
	unmatched: "rgba(100, 116, 139, 0.45)",
	edge: {
		matched: "rgba(234, 88, 12, 0.65)",
		unmatched: "rgba(100, 116, 139, 0.3)",
	},
} as const;

const graphForest = {
	subject: {
		"1": "#34d399", // emerald
		"2": "#86efac", // mint
		"3": "#fbbf24", // amber
		"4": "#22d3ee", // cyan
		"5": "#a78bfa", // violet
		"6": "#fb7185", // rose
		"7": "#bef264", // lime
		"8": "#fdba74", // peach
	},
	unmatched: "rgba(180, 220, 195, 0.42)",
	edge: {
		matched: "rgba(52, 211, 153, 0.7)",
		unmatched: "rgba(180, 220, 195, 0.28)",
	},
} as const;

const graphNord = {
	subject: {
		"1": "#88c0d0", // frost
		"2": "#81a1c1", // blue
		"3": "#a3be8c", // green
		"4": "#ebcb8b", // yellow
		"5": "#bf616a", // red
		"6": "#8fbcbb", // teal
		"7": "#b48ead", // purple
		"8": "#d08770", // orange
	},
	unmatched: "rgba(200, 210, 230, 0.42)",
	edge: {
		matched: "rgba(136, 192, 208, 0.7)",
		unmatched: "rgba(200, 210, 230, 0.28)",
	},
} as const;

const graphAurora = {
	subject: {
		"1": "#e879f9", // fuchsia
		"2": "#c4b5fd", // violet
		"3": "#67e8f9", // cyan
		"4": "#fda4af", // rose
		"5": "#fcd34d", // amber
		"6": "#7dd3fc", // sky
		"7": "#86efac", // mint
		"8": "#f0abfc", // orchid
	},
	unmatched: "rgba(210, 190, 240, 0.42)",
	edge: {
		matched: "rgba(217, 70, 239, 0.7)",
		unmatched: "rgba(210, 190, 240, 0.28)",
	},
} as const;

const graphMint = {
	subject: {
		"1": "#0d9488", // teal
		"2": "#0891b2", // cyan
		"3": "#059669", // emerald
		"4": "#7c3aed", // violet
		"5": "#dc2626", // red
		"6": "#d97706", // amber
		"7": "#65a30d", // olive
		"8": "#db2777", // pink
	},
	unmatched: "rgba(60, 110, 100, 0.45)",
	edge: {
		matched: "rgba(13, 148, 136, 0.65)",
		unmatched: "rgba(60, 110, 100, 0.3)",
	},
} as const;

const graphRose = {
	subject: {
		"1": "#e11d48", // rose
		"2": "#db2777", // pink
		"3": "#c026d3", // fuchsia
		"4": "#7c3aed", // violet
		"5": "#0891b2", // cyan
		"6": "#059669", // emerald
		"7": "#d97706", // amber
		"8": "#4f46e5", // indigo
	},
	unmatched: "rgba(120, 70, 90, 0.45)",
	edge: {
		matched: "rgba(225, 29, 72, 0.65)",
		unmatched: "rgba(120, 70, 90, 0.3)",
	},
} as const;

const graphSlate = {
	subject: {
		"1": "#4f46e5", // indigo
		"2": "#2563eb", // blue
		"3": "#0891b2", // cyan
		"4": "#059669", // emerald
		"5": "#d97706", // amber
		"6": "#dc2626", // red
		"7": "#db2777", // pink
		"8": "#7c3aed", // violet
	},
	unmatched: "rgba(71, 85, 105, 0.45)",
	edge: {
		matched: "rgba(79, 70, 229, 0.65)",
		unmatched: "rgba(71, 85, 105, 0.3)",
	},
} as const;

const sharedScalars = {
	space,
	text: {
		size: textSize,
		weight: textWeight,
		family: fontFamilies,
		lineHeight: textLineHeight,
	},
	control,
	radius,
	border,
	motion,
	z,
} as const;

export const defaultDark: Tokens = {
	color: {
		background: {
			primary: palette.gray["900"],
			elevated: palette.gray["800"],
			subtle: palette.gray["700"],
			inverse: palette.gray["100"],
		},
		surface: {
			// Alpha-channel surface tones so raised cards / list rows read as
			// "slightly elevated" over any background — solid panels OR glass
			// surfaces. Replaces the previous opaque-grey blocks that fought
			// the wallpaper.
			default: "rgba(255, 255, 255, 0.05)",
			overlay: "rgba(255, 255, 255, 0.10)",
			raised: "rgba(255, 255, 255, 0.10)",
		},
		border: {
			subtle: "rgba(231, 238, 249, 0.08)",
			default: "rgba(231, 238, 249, 0.14)",
			strong: "rgba(231, 238, 249, 0.28)",
		},
		text: {
			// White text on glass. `secondary` is identical to `primary` —
			// the secondary grey was a visual hierarchy crutch that turned
			// into illegibility against light wallpapers. Tertiary stays as
			// a very subtle alpha for genuinely-low-priority hints.
			primary: palette.gray["50"],
			secondary: palette.gray["50"],
			tertiary: "rgba(247, 247, 247, 0.62)",
			inverse: palette.gray["900"],
			link: palette.blue["400"],
		},
		accent: {
			subtle: "rgba(106, 169, 255, 0.16)",
			default: palette.blue["400"],
			strong: palette.blue["500"],
			text: palette.gray["900"],
			onSurface: palette.blue["400"],
			onFill: palette.blue["400"],
		},
		gloss: {
			// A real TWO-colour face: vivid violet at the top rotating to a
			// clear blue at the bottom (the hue travels ~40°, like the
			// reference purple→blue — NOT a single-hue lightness ramp). No
			// light/white top stop; the glass cue is the thin inset edge
			// glint + soft blurred speculars.
			top: "#9a7cff",
			bottom: "#4f7ef5",
			shineTop: "rgba(214, 206, 255, 0.6)",
			shineBottom: "rgba(190, 224, 255, 0.7)",
			innerTop: "rgba(255, 255, 255, 0.30)",
			innerBottom: "rgba(120, 150, 255, 0.22)",
		},
		state: {
			success: palette.green["400"],
			warning: palette.amber["400"],
			error: palette.red["400"],
			info: palette.cyan["400"],
		},
		chrome: {
			background: palette.gray["900"],
			text: palette.gray["100"],
		},
		shadow: {
			subtle: "rgba(0, 0, 0, 0.16)",
			default: "rgba(0, 0, 0, 0.28)",
			strong: "rgba(0, 0, 0, 0.45)",
		},
		focus: {
			ring: palette.blue["400"],
		},
		interactive: {
			hover: "rgba(255, 255, 255, 0.10)",
			active: "rgba(255, 255, 255, 0.18)",
		},
		glass: {
			// Aerial frosted glass — darker grey tint so white text holds
			// contrast on bright wallpapers. Three densities sit close so
			// settings stays in the same visual family as dashboard chrome.
			backgroundSubtle: "rgba(50, 50, 50, 0.38)",
			background: "rgba(50, 50, 50, 0.48)",
			backgroundStrong: "rgba(50, 50, 50, 0.6)",
			border: "rgba(255, 255, 255, 0.14)",
		},
		dimmer: "rgba(0, 0, 0, 0.3)",
		textShadowOnGlass: "0 1px 2px rgba(0, 0, 0, 0.45)",
		graph: graphDark,
	},
	...sharedScalars,
	shadow: {
		none: "none",
		sm: "0 1px 2px rgba(0, 0, 0, 0.16)",
		md: "0 2px 8px rgba(0, 0, 0, 0.28)",
		lg: "0 8px 24px rgba(0, 0, 0, 0.40)",
		xl: "0 16px 48px rgba(0, 0, 0, 0.55)",
	},
	glass: {
		blur: "10px",
		saturate: "180%",
	},
};

export const defaultLight: Tokens = {
	color: {
		background: {
			primary: palette.gray["50"],
			elevated: "#ffffff",
			subtle: palette.gray["100"],
			inverse: palette.gray["900"],
		},
		surface: {
			// Alpha-channel raised surfaces — see dark-mode comment above.
			default: "rgba(0, 0, 0, 0.04)",
			overlay: "rgba(0, 0, 0, 0.08)",
			raised: "rgba(0, 0, 0, 0.08)",
		},
		border: {
			subtle: "rgba(17, 26, 46, 0.06)",
			default: "rgba(17, 26, 46, 0.12)",
			strong: "rgba(17, 26, 46, 0.25)",
		},
		text: {
			// Light theme mirrors dark — primary = secondary (no useless
			// grey middle tier), tertiary a subtle alpha for hints. The alpha is
			// 0.62 (not 0.55): 0.55 rendered muted labels at 4.09:1 on the app bg,
			// just under WCAG AA (4.5:1); 0.62 clears it (session 375 a11y audit).
			primary: palette.gray["900"],
			secondary: palette.gray["900"],
			tertiary: "rgba(17, 17, 17, 0.62)",
			inverse: palette.gray["50"],
			link: palette.blue["600"],
		},
		accent: {
			subtle: "rgba(74, 144, 255, 0.12)",
			default: palette.blue["500"],
			strong: palette.blue["600"],
			text: "#ffffff",
			onSurface: palette.blue["600"],
			onFill: palette.blue["600"],
		},
		gloss: {
			// Violet→blue, same hue travel as dark but a touch deeper for
			// contrast on the light surfaces.
			top: "#7c5cf6",
			bottom: "#3f72e6",
			shineTop: "rgba(224, 218, 255, 0.65)",
			shineBottom: "rgba(200, 224, 255, 0.7)",
			innerTop: "rgba(255, 255, 255, 0.45)",
			innerBottom: "rgba(120, 150, 255, 0.20)",
		},
		state: {
			success: palette.green["600"],
			warning: palette.amber["600"],
			error: palette.red["600"],
			info: palette.cyan["600"],
		},
		chrome: {
			background: palette.gray["50"],
			text: palette.gray["900"],
		},
		shadow: {
			subtle: "rgba(17, 26, 46, 0.06)",
			default: "rgba(17, 26, 46, 0.10)",
			strong: "rgba(17, 26, 46, 0.18)",
		},
		focus: {
			ring: palette.blue["500"],
		},
		interactive: {
			hover: "rgba(17, 26, 46, 0.06)",
			active: "rgba(17, 26, 46, 0.12)",
		},
		glass: {
			// Light-theme glass — low-alpha white veil so the wallpaper
			// colour bleeds through and the blur + saturate filters read as
			// genuine frosted glass rather than a near-opaque white panel.
			// Mirrors the dark-mode alpha range (~0.2–0.5) so both themes
			// share a tactile feel; dark text on a 0.5-alpha white surface
			// still meets contrast on any reasonable wallpaper.
			backgroundSubtle: "rgba(255, 255, 255, 0.2)",
			background: "rgba(255, 255, 255, 0.32)",
			backgroundStrong: "rgba(255, 255, 255, 0.5)",
			border: "rgba(17, 26, 46, 0.10)",
		},
		dimmer: "rgba(0, 0, 0, 0.18)",
		textShadowOnGlass: "0 1px 1px rgba(255, 255, 255, 0.6)",
		graph: graphLight,
	},
	...sharedScalars,
	shadow: {
		none: "none",
		sm: "0 1px 2px rgba(17, 26, 46, 0.08)",
		md: "0 2px 8px rgba(17, 26, 46, 0.10)",
		lg: "0 8px 24px rgba(17, 26, 46, 0.14)",
		xl: "0 16px 48px rgba(17, 26, 46, 0.20)",
	},
	glass: {
		blur: "10px",
		saturate: "180%",
	},
};

// Midnight — a deeper, cooler dark theme. Surfaces lean into a navy /
// slate undertone with a brighter cyan accent. Designed for late-evening
// focus on the dashboard.
export const midnight: Tokens = {
	color: {
		background: {
			primary: "#0a1020",
			elevated: "#121a30",
			subtle: "#1a2440",
			inverse: "#e7eef9",
		},
		surface: {
			default: "rgba(140, 170, 255, 0.06)",
			overlay: "rgba(140, 170, 255, 0.12)",
			raised: "rgba(140, 170, 255, 0.12)",
		},
		border: {
			subtle: "rgba(180, 200, 255, 0.08)",
			default: "rgba(180, 200, 255, 0.16)",
			strong: "rgba(180, 200, 255, 0.32)",
		},
		text: {
			primary: "#e7eef9",
			secondary: "#e7eef9",
			tertiary: "rgba(231, 238, 249, 0.6)",
			inverse: "#0a1020",
			link: "#7dd3fc",
		},
		accent: {
			subtle: "rgba(56, 189, 248, 0.16)",
			default: "#38bdf8",
			strong: "#0ea5e9",
			text: "#0a1020",
			onSurface: "#38bdf8",
			onFill: "#38bdf8",
		},
		gloss: {
			// Bright cyan→blue — Midnight's cooler two-colour face.
			top: "#5cc6f8",
			bottom: "#2f7be0",
			shineTop: "rgba(200, 236, 255, 0.65)",
			shineBottom: "rgba(190, 240, 250, 0.7)",
			innerTop: "rgba(216, 236, 255, 0.40)",
			innerBottom: "rgba(60, 180, 230, 0.25)",
		},
		state: {
			success: "#34d399",
			warning: "#fbbf24",
			error: "#f87171",
			info: "#22d3ee",
		},
		chrome: {
			background: "#0a1020",
			text: "#e7eef9",
		},
		shadow: {
			subtle: "rgba(0, 0, 0, 0.24)",
			default: "rgba(0, 0, 0, 0.36)",
			strong: "rgba(0, 0, 0, 0.55)",
		},
		focus: {
			ring: "#38bdf8",
		},
		interactive: {
			hover: "rgba(160, 190, 255, 0.10)",
			active: "rgba(160, 190, 255, 0.18)",
		},
		glass: {
			backgroundSubtle: "rgba(20, 32, 60, 0.42)",
			background: "rgba(20, 32, 60, 0.55)",
			backgroundStrong: "rgba(20, 32, 60, 0.7)",
			border: "rgba(180, 200, 255, 0.14)",
		},
		dimmer: "rgba(0, 0, 0, 0.4)",
		textShadowOnGlass: "0 1px 2px rgba(0, 0, 0, 0.55)",
		graph: graphMidnight,
	},
	...sharedScalars,
	shadow: {
		none: "none",
		sm: "0 1px 2px rgba(0, 0, 0, 0.24)",
		md: "0 2px 8px rgba(0, 0, 0, 0.36)",
		lg: "0 8px 24px rgba(0, 0, 0, 0.5)",
		xl: "0 16px 48px rgba(0, 0, 0, 0.65)",
	},
	glass: {
		blur: "10px",
		saturate: "180%",
	},
};

// Sepia — warm paper tones with a serif body stack. The accent is a
// muted terracotta so the theme reads "long-form reading" rather than
// "product UI". Light variant.
export const sepia: Tokens = {
	color: {
		background: {
			primary: "#f3ead8",
			elevated: "#faf3e1",
			subtle: "#ebe0c8",
			inverse: "#3a2e1a",
		},
		surface: {
			default: "rgba(58, 46, 26, 0.05)",
			overlay: "rgba(58, 46, 26, 0.10)",
			raised: "rgba(58, 46, 26, 0.10)",
		},
		border: {
			subtle: "rgba(58, 46, 26, 0.10)",
			default: "rgba(58, 46, 26, 0.18)",
			strong: "rgba(58, 46, 26, 0.32)",
		},
		text: {
			primary: "#3a2e1a",
			secondary: "#3a2e1a",
			tertiary: "rgba(58, 46, 26, 0.6)",
			inverse: "#f3ead8",
			link: "#9a3d12",
		},
		accent: {
			subtle: "rgba(154, 61, 18, 0.14)",
			default: "#b04a18",
			strong: "#9a3d12",
			text: "#f3ead8",
			onSurface: "#b04a18",
			onFill: "#b04a18",
		},
		gloss: {
			// Warm orange→brick two-colour face; warm (cream/amber)
			// speculars rather than the cool ones of the dark themes so the
			// gloss stays inside Sepia's paper palette.
			top: "#d4691f",
			bottom: "#8a360f",
			shineTop: "rgba(255, 225, 190, 0.6)",
			shineBottom: "rgba(255, 210, 170, 0.6)",
			innerTop: "rgba(255, 233, 199, 0.45)",
			innerBottom: "rgba(150, 80, 30, 0.25)",
		},
		state: {
			success: "#3f6212",
			warning: "#a16207",
			error: "#991b1b",
			info: "#0e7490",
		},
		chrome: {
			background: "#f3ead8",
			text: "#3a2e1a",
		},
		shadow: {
			subtle: "rgba(58, 46, 26, 0.08)",
			default: "rgba(58, 46, 26, 0.14)",
			strong: "rgba(58, 46, 26, 0.22)",
		},
		focus: {
			ring: "#b04a18",
		},
		interactive: {
			hover: "rgba(58, 46, 26, 0.08)",
			active: "rgba(58, 46, 26, 0.16)",
		},
		glass: {
			// Same logic as light theme — low-alpha cream veil. The cream
			// tint stays warm enough that text contrast is fine on any
			// wallpaper, but the wallpaper still reads through the blur.
			backgroundSubtle: "rgba(250, 243, 225, 0.22)",
			background: "rgba(250, 243, 225, 0.36)",
			backgroundStrong: "rgba(250, 243, 225, 0.54)",
			border: "rgba(58, 46, 26, 0.14)",
		},
		dimmer: "rgba(58, 46, 26, 0.2)",
		textShadowOnGlass: "0 1px 1px rgba(255, 248, 230, 0.6)",
		graph: graphSepia,
	},
	...sharedScalars,
	// Sepia is the only built-in that overrides the typography family —
	// spread sharedScalars.text first so a new sibling key (e.g. a future
	// `tracking` scale) doesn't silently drop out of this theme.
	text: { ...sharedScalars.text, family: serifFontFamilies },
	shadow: {
		none: "none",
		sm: "0 1px 2px rgba(58, 46, 26, 0.10)",
		md: "0 2px 8px rgba(58, 46, 26, 0.14)",
		lg: "0 8px 24px rgba(58, 46, 26, 0.18)",
		xl: "0 16px 48px rgba(58, 46, 26, 0.24)",
	},
	glass: {
		blur: "10px",
		saturate: "180%",
	},
};

// High Contrast — accessibility-focused dark theme. Pure black surfaces,
// pure white text, saturated yellow accent. State colors maximise
// distinguishability rather than fitting a palette.
export const highContrast: Tokens = {
	color: {
		background: {
			primary: "#000000",
			elevated: "#0a0a0a",
			subtle: "#141414",
			inverse: "#ffffff",
		},
		surface: {
			default: "rgba(255, 255, 255, 0.08)",
			overlay: "rgba(255, 255, 255, 0.16)",
			raised: "rgba(255, 255, 255, 0.16)",
		},
		border: {
			subtle: "rgba(255, 255, 255, 0.3)",
			default: "rgba(255, 255, 255, 0.55)",
			strong: "#ffffff",
		},
		text: {
			primary: "#ffffff",
			secondary: "#ffffff",
			tertiary: "rgba(255, 255, 255, 0.85)",
			inverse: "#000000",
			link: "#ffd400",
		},
		accent: {
			subtle: "rgba(255, 212, 0, 0.2)",
			default: "#ffd400",
			strong: "#ffea00",
			text: "#000000",
			onSurface: "#ffd400",
			onFill: "#ffd400",
		},
		gloss: {
			// High Contrast deliberately suppresses the soft-glass look
			// (blur 0, opaque surfaces): a tight near-flat yellow gradient
			// and plain-white glints so the button reads as a crisp solid.
			top: "#ffe000",
			bottom: "#f0c800",
			shineTop: "rgba(255, 255, 255, 0.5)",
			shineBottom: "rgba(255, 255, 255, 0.5)",
			innerTop: "rgba(255, 255, 255, 0.5)",
			innerBottom: "rgba(255, 255, 255, 0.25)",
		},
		state: {
			success: "#00ff7f",
			warning: "#ffd400",
			error: "#ff5252",
			info: "#00e5ff",
		},
		chrome: {
			background: "#000000",
			text: "#ffffff",
		},
		shadow: {
			subtle: "rgba(0, 0, 0, 0.8)",
			default: "rgba(0, 0, 0, 0.9)",
			strong: "rgba(0, 0, 0, 1)",
		},
		focus: {
			ring: "#ffd400",
		},
		interactive: {
			hover: "rgba(255, 255, 255, 0.18)",
			active: "rgba(255, 255, 255, 0.3)",
		},
		glass: {
			// High contrast disables the frosted-glass aesthetic — surfaces
			// stay opaque black so text against them holds AAA contrast on
			// every wallpaper.
			backgroundSubtle: "rgba(0, 0, 0, 0.85)",
			background: "rgba(0, 0, 0, 0.92)",
			backgroundStrong: "#000000",
			border: "#ffffff",
		},
		dimmer: "rgba(0, 0, 0, 0.7)",
		textShadowOnGlass: "0 0 0 transparent",
		graph: graphHighContrast,
	},
	...sharedScalars,
	shadow: {
		none: "none",
		sm: "0 0 0 1px #ffffff",
		md: "0 0 0 2px #ffffff",
		lg: "0 4px 0 0 #ffffff",
		xl: "0 8px 0 0 #ffffff",
	},
	glass: {
		blur: "0px",
		saturate: "100%",
	},
};

// Solar — crisp cool-white surfaces with a saturated orange accent. Pairs
// the bright/optimistic mood of a sunlit desk with sans-serif UI text, so
// it sits between Default Light (neutral product UI) and Sepia (warm
// long-form reading) as a third light option. Light variant.
export const solar: Tokens = {
	color: {
		background: {
			primary: "#f7f8fa",
			elevated: "#ffffff",
			subtle: "#ebeef3",
			inverse: palette.gray["900"],
		},
		surface: {
			default: "rgba(20, 30, 60, 0.04)",
			overlay: "rgba(20, 30, 60, 0.08)",
			raised: "rgba(20, 30, 60, 0.08)",
		},
		border: {
			subtle: "rgba(20, 30, 60, 0.08)",
			default: "rgba(20, 30, 60, 0.14)",
			strong: "rgba(20, 30, 60, 0.28)",
		},
		text: {
			primary: "#1f2937",
			secondary: "#1f2937",
			tertiary: "rgba(31, 41, 55, 0.62)",
			inverse: "#f7f8fa",
			link: "#c2410c",
		},
		accent: {
			subtle: "rgba(234, 88, 12, 0.14)",
			default: "#ea580c",
			strong: "#c2410c",
			text: "#ffffff",
			onSurface: "#c2410c",
			onFill: "#c2410c",
		},
		gloss: {
			// Warm orange→amber two-colour face — matches Solar's accent.
			top: "#fb923c",
			bottom: "#c2410c",
			shineTop: "rgba(255, 222, 192, 0.65)",
			shineBottom: "rgba(255, 210, 170, 0.7)",
			innerTop: "rgba(255, 255, 255, 0.45)",
			innerBottom: "rgba(220, 100, 30, 0.22)",
		},
		state: {
			success: palette.green["600"],
			warning: palette.amber["600"],
			error: palette.red["600"],
			info: palette.cyan["600"],
		},
		chrome: {
			background: "#f7f8fa",
			text: "#1f2937",
		},
		shadow: {
			subtle: "rgba(31, 41, 55, 0.06)",
			default: "rgba(31, 41, 55, 0.10)",
			strong: "rgba(31, 41, 55, 0.18)",
		},
		focus: {
			ring: "#ea580c",
		},
		interactive: {
			hover: "rgba(31, 41, 55, 0.06)",
			active: "rgba(31, 41, 55, 0.12)",
		},
		glass: {
			// Cool-white veil — mirrors defaultLight's alpha range so the
			// wallpaper bleeds through and Solar's orange accent reads
			// confidently against any wallpaper.
			backgroundSubtle: "rgba(255, 255, 255, 0.22)",
			background: "rgba(255, 255, 255, 0.36)",
			backgroundStrong: "rgba(255, 255, 255, 0.5)",
			border: "rgba(31, 41, 55, 0.10)",
		},
		dimmer: "rgba(31, 41, 55, 0.18)",
		textShadowOnGlass: "0 1px 1px rgba(255, 255, 255, 0.6)",
		graph: graphSolar,
	},
	...sharedScalars,
	shadow: {
		none: "none",
		sm: "0 1px 2px rgba(31, 41, 55, 0.08)",
		md: "0 2px 8px rgba(31, 41, 55, 0.10)",
		lg: "0 8px 24px rgba(31, 41, 55, 0.14)",
		xl: "0 16px 48px rgba(31, 41, 55, 0.20)",
	},
	glass: {
		blur: "10px",
		saturate: "180%",
	},
};

// Forest — a deep evergreen dark theme. Near-black surfaces carry a faint
// green undertone and the accent is a clear emerald, so the dashboard reads
// "calm woodland" rather than the neutral grey of Default Dark. Dark variant.
export const forest: Tokens = {
	color: {
		background: {
			primary: "#0c130f",
			elevated: "#121b15",
			subtle: "#1a261d",
			inverse: "#e6f0e8",
		},
		surface: {
			default: "rgba(150, 255, 190, 0.05)",
			overlay: "rgba(150, 255, 190, 0.10)",
			raised: "rgba(150, 255, 190, 0.10)",
		},
		border: {
			subtle: "rgba(190, 235, 205, 0.08)",
			default: "rgba(190, 235, 205, 0.16)",
			strong: "rgba(190, 235, 205, 0.30)",
		},
		text: {
			primary: "#e6f0e8",
			secondary: "#e6f0e8",
			tertiary: "rgba(230, 240, 232, 0.6)",
			inverse: "#0c130f",
			link: "#6ee7b7",
		},
		accent: {
			subtle: "rgba(52, 211, 153, 0.16)",
			default: "#34d399",
			strong: "#10b981",
			text: "#0c130f",
			onSurface: "#34d399",
			onFill: "#34d399",
		},
		gloss: {
			// Bright leaf-green → deep forest green two-colour face.
			top: "#5be39b",
			bottom: "#0f9d6e",
			shineTop: "rgba(206, 255, 226, 0.6)",
			shineBottom: "rgba(190, 250, 220, 0.7)",
			innerTop: "rgba(255, 255, 255, 0.30)",
			innerBottom: "rgba(40, 180, 120, 0.24)",
		},
		state: {
			success: "#34d399",
			warning: "#fbbf24",
			error: "#f87171",
			info: "#22d3ee",
		},
		chrome: {
			background: "#0c130f",
			text: "#e6f0e8",
		},
		shadow: {
			subtle: "rgba(0, 0, 0, 0.20)",
			default: "rgba(0, 0, 0, 0.32)",
			strong: "rgba(0, 0, 0, 0.5)",
		},
		focus: {
			ring: "#34d399",
		},
		interactive: {
			hover: "rgba(170, 240, 200, 0.10)",
			active: "rgba(170, 240, 200, 0.18)",
		},
		glass: {
			backgroundSubtle: "rgba(22, 38, 28, 0.42)",
			background: "rgba(22, 38, 28, 0.55)",
			backgroundStrong: "rgba(22, 38, 28, 0.7)",
			border: "rgba(190, 235, 205, 0.14)",
		},
		dimmer: "rgba(0, 0, 0, 0.4)",
		textShadowOnGlass: "0 1px 2px rgba(0, 0, 0, 0.55)",
		graph: graphForest,
	},
	...sharedScalars,
	shadow: {
		none: "none",
		sm: "0 1px 2px rgba(0, 0, 0, 0.20)",
		md: "0 2px 8px rgba(0, 0, 0, 0.32)",
		lg: "0 8px 24px rgba(0, 0, 0, 0.45)",
		xl: "0 16px 48px rgba(0, 0, 0, 0.6)",
	},
	glass: {
		blur: "10px",
		saturate: "180%",
	},
};

// Nord — an arctic dark theme built on the Polar Night / Frost palette. Cool
// blue-grey slate surfaces with a calm frost-blue accent; softer than Default
// Dark and lighter than Midnight. Dark variant.
export const nord: Tokens = {
	color: {
		background: {
			primary: "#2e3440",
			elevated: "#3b4252",
			subtle: "#434c5e",
			inverse: "#eceff4",
		},
		surface: {
			default: "rgba(216, 222, 233, 0.06)",
			overlay: "rgba(216, 222, 233, 0.12)",
			raised: "rgba(216, 222, 233, 0.12)",
		},
		border: {
			subtle: "rgba(216, 222, 233, 0.10)",
			default: "rgba(216, 222, 233, 0.18)",
			strong: "rgba(216, 222, 233, 0.34)",
		},
		text: {
			primary: "#eceff4",
			secondary: "#eceff4",
			tertiary: "rgba(236, 239, 244, 0.62)",
			inverse: "#2e3440",
			link: "#88c0d0",
		},
		accent: {
			subtle: "rgba(136, 192, 208, 0.18)",
			default: "#88c0d0",
			strong: "#5e81ac",
			text: "#2e3440",
			onSurface: "#88c0d0",
			onFill: "#88c0d0",
		},
		gloss: {
			// Frost teal → deep frost blue two-colour face.
			top: "#8fbcbb",
			bottom: "#5e81ac",
			shineTop: "rgba(224, 240, 244, 0.65)",
			shineBottom: "rgba(208, 232, 240, 0.7)",
			innerTop: "rgba(236, 244, 248, 0.40)",
			innerBottom: "rgba(94, 129, 172, 0.26)",
		},
		state: {
			success: "#a3be8c",
			warning: "#ebcb8b",
			error: "#bf616a",
			info: "#88c0d0",
		},
		chrome: {
			background: "#2e3440",
			text: "#eceff4",
		},
		shadow: {
			subtle: "rgba(0, 0, 0, 0.20)",
			default: "rgba(0, 0, 0, 0.30)",
			strong: "rgba(0, 0, 0, 0.45)",
		},
		focus: {
			ring: "#88c0d0",
		},
		interactive: {
			hover: "rgba(216, 222, 233, 0.10)",
			active: "rgba(216, 222, 233, 0.18)",
		},
		glass: {
			backgroundSubtle: "rgba(46, 52, 64, 0.46)",
			background: "rgba(46, 52, 64, 0.58)",
			backgroundStrong: "rgba(46, 52, 64, 0.72)",
			border: "rgba(216, 222, 233, 0.16)",
		},
		dimmer: "rgba(0, 0, 0, 0.36)",
		textShadowOnGlass: "0 1px 2px rgba(0, 0, 0, 0.5)",
		graph: graphNord,
	},
	...sharedScalars,
	shadow: {
		none: "none",
		sm: "0 1px 2px rgba(0, 0, 0, 0.20)",
		md: "0 2px 8px rgba(0, 0, 0, 0.30)",
		lg: "0 8px 24px rgba(0, 0, 0, 0.42)",
		xl: "0 16px 48px rgba(0, 0, 0, 0.55)",
	},
	glass: {
		blur: "10px",
		saturate: "180%",
	},
};

// Aurora — a vivid dark theme of deep violet-indigo surfaces lit by a
// fuchsia-magenta accent, like northern lights over a night sky. The most
// saturated of the dark set. Dark variant.
export const aurora: Tokens = {
	color: {
		background: {
			primary: "#160f23",
			elevated: "#1f1733",
			subtle: "#2a2042",
			inverse: "#f0e9fb",
		},
		surface: {
			default: "rgba(220, 180, 255, 0.06)",
			overlay: "rgba(220, 180, 255, 0.12)",
			raised: "rgba(220, 180, 255, 0.12)",
		},
		border: {
			subtle: "rgba(220, 190, 255, 0.10)",
			default: "rgba(220, 190, 255, 0.18)",
			strong: "rgba(220, 190, 255, 0.34)",
		},
		text: {
			primary: "#f0e9fb",
			secondary: "#f0e9fb",
			tertiary: "rgba(240, 233, 251, 0.62)",
			inverse: "#160f23",
			link: "#e879f9",
		},
		accent: {
			subtle: "rgba(217, 70, 239, 0.18)",
			default: "#d946ef",
			strong: "#c026d3",
			text: "#160f23",
			onSurface: "#d946ef",
			onFill: "#d946ef",
		},
		gloss: {
			// Orchid → magenta two-colour face — the aurora's brightest band.
			top: "#e066f5",
			bottom: "#a21caf",
			shineTop: "rgba(245, 214, 255, 0.6)",
			shineBottom: "rgba(232, 200, 255, 0.7)",
			innerTop: "rgba(255, 255, 255, 0.30)",
			innerBottom: "rgba(170, 40, 180, 0.26)",
		},
		state: {
			success: "#34d399",
			warning: "#fbbf24",
			error: "#fb7185",
			info: "#22d3ee",
		},
		chrome: {
			background: "#160f23",
			text: "#f0e9fb",
		},
		shadow: {
			subtle: "rgba(0, 0, 0, 0.24)",
			default: "rgba(0, 0, 0, 0.36)",
			strong: "rgba(0, 0, 0, 0.55)",
		},
		focus: {
			ring: "#d946ef",
		},
		interactive: {
			hover: "rgba(225, 190, 255, 0.10)",
			active: "rgba(225, 190, 255, 0.18)",
		},
		glass: {
			backgroundSubtle: "rgba(31, 23, 51, 0.44)",
			background: "rgba(31, 23, 51, 0.56)",
			backgroundStrong: "rgba(31, 23, 51, 0.72)",
			border: "rgba(220, 190, 255, 0.16)",
		},
		dimmer: "rgba(0, 0, 0, 0.42)",
		textShadowOnGlass: "0 1px 2px rgba(0, 0, 0, 0.55)",
		graph: graphAurora,
	},
	...sharedScalars,
	shadow: {
		none: "none",
		sm: "0 1px 2px rgba(0, 0, 0, 0.24)",
		md: "0 2px 8px rgba(0, 0, 0, 0.36)",
		lg: "0 8px 24px rgba(0, 0, 0, 0.5)",
		xl: "0 16px 48px rgba(0, 0, 0, 0.65)",
	},
	glass: {
		blur: "10px",
		saturate: "180%",
	},
};

// Mint — a cool, fresh light theme. Faintly green-tinted white surfaces with
// a confident teal accent; sits beside Default Light as a calmer, cooler
// alternative. Light variant.
export const mint: Tokens = {
	color: {
		background: {
			primary: "#f2faf6",
			elevated: "#ffffff",
			subtle: "#e3f2eb",
			inverse: "#143028",
		},
		surface: {
			default: "rgba(15, 60, 50, 0.04)",
			overlay: "rgba(15, 60, 50, 0.08)",
			raised: "rgba(15, 60, 50, 0.08)",
		},
		border: {
			subtle: "rgba(15, 60, 50, 0.08)",
			default: "rgba(15, 60, 50, 0.14)",
			strong: "rgba(15, 60, 50, 0.28)",
		},
		text: {
			primary: "#143028",
			secondary: "#143028",
			tertiary: "rgba(20, 48, 40, 0.62)",
			inverse: "#f2faf6",
			link: "#0f766e",
		},
		accent: {
			subtle: "rgba(13, 148, 136, 0.14)",
			default: "#0d9488",
			strong: "#0f766e",
			text: "#ffffff",
			onSurface: "#0f766e",
			onFill: "#0f766e",
		},
		gloss: {
			// Bright teal → deep teal two-colour face.
			top: "#2dd4bf",
			bottom: "#0f766e",
			shineTop: "rgba(204, 250, 240, 0.65)",
			shineBottom: "rgba(190, 244, 230, 0.7)",
			innerTop: "rgba(255, 255, 255, 0.45)",
			innerBottom: "rgba(15, 118, 110, 0.20)",
		},
		state: {
			success: palette.green["600"],
			warning: palette.amber["600"],
			error: palette.red["600"],
			info: palette.cyan["600"],
		},
		chrome: {
			background: "#f2faf6",
			text: "#143028",
		},
		shadow: {
			subtle: "rgba(20, 48, 40, 0.06)",
			default: "rgba(20, 48, 40, 0.10)",
			strong: "rgba(20, 48, 40, 0.18)",
		},
		focus: {
			ring: "#0d9488",
		},
		interactive: {
			hover: "rgba(20, 48, 40, 0.06)",
			active: "rgba(20, 48, 40, 0.12)",
		},
		glass: {
			backgroundSubtle: "rgba(255, 255, 255, 0.22)",
			background: "rgba(255, 255, 255, 0.36)",
			backgroundStrong: "rgba(255, 255, 255, 0.5)",
			border: "rgba(20, 48, 40, 0.10)",
		},
		dimmer: "rgba(20, 48, 40, 0.18)",
		textShadowOnGlass: "0 1px 1px rgba(255, 255, 255, 0.6)",
		graph: graphMint,
	},
	...sharedScalars,
	shadow: {
		none: "none",
		sm: "0 1px 2px rgba(20, 48, 40, 0.08)",
		md: "0 2px 8px rgba(20, 48, 40, 0.10)",
		lg: "0 8px 24px rgba(20, 48, 40, 0.14)",
		xl: "0 16px 48px rgba(20, 48, 40, 0.20)",
	},
	glass: {
		blur: "10px",
		saturate: "180%",
	},
};

// Rose — a warm light theme with blush-tinted surfaces and a rose accent.
// Soft and inviting; the warm-light counterpart to Mint's cool light.
// Light variant.
export const rose: Tokens = {
	color: {
		background: {
			primary: "#fdf4f6",
			elevated: "#ffffff",
			subtle: "#f9e5ea",
			inverse: "#3a1f29",
		},
		surface: {
			default: "rgba(90, 25, 45, 0.04)",
			overlay: "rgba(90, 25, 45, 0.08)",
			raised: "rgba(90, 25, 45, 0.08)",
		},
		border: {
			subtle: "rgba(90, 25, 45, 0.08)",
			default: "rgba(90, 25, 45, 0.14)",
			strong: "rgba(90, 25, 45, 0.28)",
		},
		text: {
			primary: "#3a1f29",
			secondary: "#3a1f29",
			tertiary: "rgba(58, 31, 41, 0.62)",
			inverse: "#fdf4f6",
			link: "#be123c",
		},
		accent: {
			subtle: "rgba(225, 29, 72, 0.12)",
			default: "#e11d48",
			strong: "#be123c",
			text: "#ffffff",
			onSurface: "#be123c",
			onFill: "#e11d48",
		},
		gloss: {
			// Bright rose → deep crimson two-colour face.
			top: "#fb7185",
			bottom: "#be123c",
			shineTop: "rgba(255, 220, 228, 0.65)",
			shineBottom: "rgba(255, 206, 216, 0.7)",
			innerTop: "rgba(255, 255, 255, 0.45)",
			innerBottom: "rgba(190, 18, 60, 0.20)",
		},
		state: {
			success: palette.green["600"],
			warning: palette.amber["600"],
			error: palette.red["600"],
			info: palette.cyan["600"],
		},
		chrome: {
			background: "#fdf4f6",
			text: "#3a1f29",
		},
		shadow: {
			subtle: "rgba(58, 31, 41, 0.06)",
			default: "rgba(58, 31, 41, 0.10)",
			strong: "rgba(58, 31, 41, 0.18)",
		},
		focus: {
			ring: "#e11d48",
		},
		interactive: {
			hover: "rgba(58, 31, 41, 0.06)",
			active: "rgba(58, 31, 41, 0.12)",
		},
		glass: {
			backgroundSubtle: "rgba(255, 255, 255, 0.22)",
			background: "rgba(255, 255, 255, 0.36)",
			backgroundStrong: "rgba(255, 255, 255, 0.5)",
			border: "rgba(58, 31, 41, 0.10)",
		},
		dimmer: "rgba(58, 31, 41, 0.18)",
		textShadowOnGlass: "0 1px 1px rgba(255, 255, 255, 0.6)",
		graph: graphRose,
	},
	...sharedScalars,
	shadow: {
		none: "none",
		sm: "0 1px 2px rgba(58, 31, 41, 0.08)",
		md: "0 2px 8px rgba(58, 31, 41, 0.10)",
		lg: "0 8px 24px rgba(58, 31, 41, 0.14)",
		xl: "0 16px 48px rgba(58, 31, 41, 0.20)",
	},
	glass: {
		blur: "10px",
		saturate: "180%",
	},
};

// Slate — a cool neutral-grey light theme with a confident indigo accent.
// The most "product UI" of the light set: crisp, businesslike, low-chroma
// surfaces. Light variant.
export const slate: Tokens = {
	color: {
		background: {
			primary: "#f4f5f7",
			elevated: "#ffffff",
			subtle: "#e6e8ed",
			inverse: "#1e293b",
		},
		surface: {
			default: "rgba(30, 41, 59, 0.04)",
			overlay: "rgba(30, 41, 59, 0.08)",
			raised: "rgba(30, 41, 59, 0.08)",
		},
		border: {
			subtle: "rgba(30, 41, 59, 0.08)",
			default: "rgba(30, 41, 59, 0.14)",
			strong: "rgba(30, 41, 59, 0.28)",
		},
		text: {
			primary: "#1e293b",
			secondary: "#1e293b",
			tertiary: "rgba(30, 41, 59, 0.62)",
			inverse: "#f4f5f7",
			link: "#4f46e5",
		},
		accent: {
			subtle: "rgba(79, 70, 229, 0.12)",
			default: "#4f46e5",
			strong: "#4338ca",
			text: "#ffffff",
			onSurface: "#4f46e5",
			onFill: "#4f46e5",
		},
		gloss: {
			// Indigo → deep indigo two-colour face.
			top: "#6366f1",
			bottom: "#4338ca",
			shineTop: "rgba(220, 222, 255, 0.65)",
			shineBottom: "rgba(204, 208, 255, 0.7)",
			innerTop: "rgba(255, 255, 255, 0.45)",
			innerBottom: "rgba(67, 56, 202, 0.20)",
		},
		state: {
			success: palette.green["600"],
			warning: palette.amber["600"],
			error: palette.red["600"],
			info: palette.cyan["600"],
		},
		chrome: {
			background: "#f4f5f7",
			text: "#1e293b",
		},
		shadow: {
			subtle: "rgba(30, 41, 59, 0.06)",
			default: "rgba(30, 41, 59, 0.10)",
			strong: "rgba(30, 41, 59, 0.18)",
		},
		focus: {
			ring: "#4f46e5",
		},
		interactive: {
			hover: "rgba(30, 41, 59, 0.06)",
			active: "rgba(30, 41, 59, 0.12)",
		},
		glass: {
			backgroundSubtle: "rgba(255, 255, 255, 0.22)",
			background: "rgba(255, 255, 255, 0.36)",
			backgroundStrong: "rgba(255, 255, 255, 0.5)",
			border: "rgba(30, 41, 59, 0.10)",
		},
		dimmer: "rgba(30, 41, 59, 0.18)",
		textShadowOnGlass: "0 1px 1px rgba(255, 255, 255, 0.6)",
		graph: graphSlate,
	},
	...sharedScalars,
	shadow: {
		none: "none",
		sm: "0 1px 2px rgba(30, 41, 59, 0.08)",
		md: "0 2px 8px rgba(30, 41, 59, 0.10)",
		lg: "0 8px 24px rgba(30, 41, 59, 0.14)",
		xl: "0 16px 48px rgba(30, 41, 59, 0.20)",
	},
	glass: {
		blur: "10px",
		saturate: "180%",
	},
};

export enum ThemeName {
	DefaultDark = "default-dark",
	DefaultLight = "default-light",
	Midnight = "midnight",
	Sepia = "sepia",
	HighContrast = "high-contrast",
	Solar = "solar",
	Forest = "forest",
	Nord = "nord",
	Aurora = "aurora",
	Mint = "mint",
	Rose = "rose",
	Slate = "slate",
}

export const themes: Record<ThemeName, Tokens> = {
	[ThemeName.DefaultDark]: defaultDark,
	[ThemeName.DefaultLight]: defaultLight,
	[ThemeName.Midnight]: midnight,
	[ThemeName.Sepia]: sepia,
	[ThemeName.HighContrast]: highContrast,
	[ThemeName.Solar]: solar,
	[ThemeName.Forest]: forest,
	[ThemeName.Nord]: nord,
	[ThemeName.Aurora]: aurora,
	[ThemeName.Mint]: mint,
	[ThemeName.Rose]: rose,
	[ThemeName.Slate]: slate,
};

export function isThemeName(value: unknown): value is ThemeName {
	return typeof value === "string" && (Object.values(ThemeName) as string[]).includes(value);
}

export const DEFAULT_THEME: ThemeName = ThemeName.Rose;

/**
 * Scheme a theme renders against — drives the Settings → Appearance slot
 * filter (a dark theme cannot land in the Light slot and vice versa) and
 * the dashboard's effective-pair resolution.
 *
 * Per §Appearance modes & pair slots.
 */
export enum ThemeAppearance {
	Light = "light",
	Dark = "dark",
}

/**
 * Display catalog for the Settings → Appearance theme picker. Preview
 * colors are sampled from each theme's own tokens so the swatch can't
 * drift from the actual rendered palette.
 */
export type ThemeCatalogEntry = {
	id: ThemeName;
	labelKey: string;
	descriptionKey: string;
	/** Which scheme this theme is designed for; pickers filter slots by it. */
	appearance: ThemeAppearance;
	preview: {
		background: string;
		surface: string;
		accent: string;
		text: string;
	};
};

export const themeCatalog: readonly ThemeCatalogEntry[] = [
	{
		id: ThemeName.DefaultDark,
		labelKey: "shell.settings.themes.defaultDark.label",
		descriptionKey: "shell.settings.themes.defaultDark.description",
		appearance: ThemeAppearance.Dark,
		preview: previewOf(defaultDark),
	},
	{
		id: ThemeName.DefaultLight,
		labelKey: "shell.settings.themes.defaultLight.label",
		descriptionKey: "shell.settings.themes.defaultLight.description",
		appearance: ThemeAppearance.Light,
		preview: previewOf(defaultLight),
	},
	{
		id: ThemeName.Midnight,
		labelKey: "shell.settings.themes.midnight.label",
		descriptionKey: "shell.settings.themes.midnight.description",
		appearance: ThemeAppearance.Dark,
		preview: previewOf(midnight),
	},
	{
		id: ThemeName.Sepia,
		labelKey: "shell.settings.themes.sepia.label",
		descriptionKey: "shell.settings.themes.sepia.description",
		appearance: ThemeAppearance.Light,
		preview: previewOf(sepia),
	},
	{
		id: ThemeName.HighContrast,
		labelKey: "shell.settings.themes.highContrast.label",
		descriptionKey: "shell.settings.themes.highContrast.description",
		appearance: ThemeAppearance.Dark,
		preview: previewOf(highContrast),
	},
	{
		id: ThemeName.Solar,
		labelKey: "shell.settings.themes.solar.label",
		descriptionKey: "shell.settings.themes.solar.description",
		appearance: ThemeAppearance.Light,
		preview: previewOf(solar),
	},
	{
		id: ThemeName.Forest,
		labelKey: "shell.settings.themes.forest.label",
		descriptionKey: "shell.settings.themes.forest.description",
		appearance: ThemeAppearance.Dark,
		preview: previewOf(forest),
	},
	{
		id: ThemeName.Nord,
		labelKey: "shell.settings.themes.nord.label",
		descriptionKey: "shell.settings.themes.nord.description",
		appearance: ThemeAppearance.Dark,
		preview: previewOf(nord),
	},
	{
		id: ThemeName.Aurora,
		labelKey: "shell.settings.themes.aurora.label",
		descriptionKey: "shell.settings.themes.aurora.description",
		appearance: ThemeAppearance.Dark,
		preview: previewOf(aurora),
	},
	{
		id: ThemeName.Mint,
		labelKey: "shell.settings.themes.mint.label",
		descriptionKey: "shell.settings.themes.mint.description",
		appearance: ThemeAppearance.Light,
		preview: previewOf(mint),
	},
	{
		id: ThemeName.Rose,
		labelKey: "shell.settings.themes.rose.label",
		descriptionKey: "shell.settings.themes.rose.description",
		appearance: ThemeAppearance.Light,
		preview: previewOf(rose),
	},
	{
		id: ThemeName.Slate,
		labelKey: "shell.settings.themes.slate.label",
		descriptionKey: "shell.settings.themes.slate.description",
		appearance: ThemeAppearance.Light,
		preview: previewOf(slate),
	},
];

const APPEARANCE_BY_NAME: Record<ThemeName, ThemeAppearance> = Object.fromEntries(
	themeCatalog.map((entry) => [entry.id, entry.appearance]),
) as Record<ThemeName, ThemeAppearance>;

/** Look up a theme's `appearance` by name. The mapping is exhaustive over
 *  `ThemeName`, so this never returns `undefined`. */
export function themeAppearance(name: ThemeName): ThemeAppearance {
	return APPEARANCE_BY_NAME[name];
}

/** Default theme for a given scheme — used as the seed for the opposite
 *  slot during migration from the pre-pair-slots world. */
export const DEFAULT_THEME_BY_APPEARANCE: Record<ThemeAppearance, ThemeName> = {
	[ThemeAppearance.Light]: ThemeName.Rose,
	[ThemeAppearance.Dark]: ThemeName.DefaultDark,
};

function previewOf(tokens: Tokens): ThemeCatalogEntry["preview"] {
	return {
		background: tokens.color.background.primary,
		surface: tokens.color.background.elevated,
		accent: tokens.color.accent.default,
		text: tokens.color.text.primary,
	};
}

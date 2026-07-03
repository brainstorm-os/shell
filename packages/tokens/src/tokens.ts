/**
 * Semantic token namespace.
 *
 * Per, all design variables in Brainstorm live in a theme.
 * This file is the source-of-truth for the semantic token shape. Concrete values are in
 * themes.ts; this file declares only the structure that every theme must populate.
 */

export type Tokens = {
	color: {
		background: {
			primary: string;
			elevated: string;
			subtle: string;
			inverse: string;
		};
		surface: {
			default: string;
			overlay: string;
			/** Chip / thumbnail surface sitting ON a `default` card (icon chips,
			 *  avatar wells) — one step stronger than `default` so it stays
			 *  visible over cards and glass alike. */
			raised: string;
		};
		border: {
			subtle: string;
			default: string;
			strong: string;
		};
		text: {
			primary: string;
			secondary: string;
			tertiary: string;
			inverse: string;
			link: string;
		};
		accent: {
			subtle: string;
			default: string;
			strong: string;
			text: string;
			/** Accent tuned for use as TEXT on a neutral surface (background /
			 *  elevated). Guaranteed ≥ WCAG AA 4.5:1 on `background.primary` in
			 *  every built-in theme (enforced by the `themes` contrast ratchet) —
			 *  `accent.default` is a brand FILL colour and fails that bar as text in
			 *  several themes. Use `--color-accent-on-surface` wherever accent
			 *  colour is applied to text; keep `accent.default` for fills, borders,
			 *  focus rings, and button faces. */
			onSurface: string;
			/** Accent FILL that carries `accent.text` on top (badges, chips,
			 *  highlight tiles). The inverse of `onSurface`: guaranteed to give
			 *  `accent.text` ≥ WCAG AA 4.5:1 in every theme (ratchet-enforced) —
			 *  `accent.default` is too light for white text in several light themes,
			 *  and its darker `accent.strong` is too dark for the dark-theme
			 *  `accent.text`, so this picks the theme-correct fill. Use it wherever
			 *  a background is `accent.*` AND foreground is `accent.text`; keep
			 *  `accent.default` for decorative fills that carry no text. */
			onFill: string;
		};
		/** Glossy-button anatomy — the `Button` Glass/Primary/Destructive
		 *  variants render a saturated theme-driven 2-colour face gradient
		 *  (`top` → `bottom`, NO white wash on the top edge) plus subtle
		 *  glass speculars. `top` / `bottom` are the face stops (Glass +
		 *  Primary share them; Destructive derives its own from
		 *  `state.error`). `shineTop` is the soft blurred top reflection;
		 *  `shineBottom` the bottom reflected glow + contact line;
		 *  `innerTop` / `innerBottom` are the 1px inset edge glints. */
		gloss: {
			top: string;
			bottom: string;
			shineTop: string;
			shineBottom: string;
			innerTop: string;
			innerBottom: string;
		};
		state: {
			success: string;
			warning: string;
			error: string;
			info: string;
		};
		chrome: {
			background: string;
			text: string;
		};
		shadow: {
			subtle: string;
			default: string;
			strong: string;
		};
		focus: {
			ring: string;
		};
		/** Interactive overlay colors — applied to icon buttons, list rows,
		 *  any clickable surface that needs a hover / active treatment that
		 *  works equally well over solid backgrounds and glass surfaces. */
		interactive: {
			hover: string;
			active: string;
		};
		/** Glass surface — semi-transparent tinted layer paired with the
		 *  `glass.blur` / `saturate` motion tokens for backdrop-filter.
		 *  Three densities: `subtle` (lightest, e.g. dashboard header on
		 *  wallpapers), `default` (most overlays), `strong` (settings panels,
		 *  surfaces that need stronger separation from wallpaper). */
		glass: {
			backgroundSubtle: string;
			background: string;
			backgroundStrong: string;
			border: string;
		};
		/** Modal-dimmer scrim — semi-transparent black, used behind every
		 *  Popover / Settings panel so the content underneath shows through
		 *  but is unmistakably "in the background". */
		dimmer: string;
		/** Text shadow applied to text laid over glass / wallpaper surfaces
		 *  to guarantee legibility on any underlying colour. */
		textShadowOnGlass: string;
		/** Graph-app palette. `subject.1`–`subject.8` are categorical hues
		 *  for distinct subjects in a pattern (Person / City / School …);
		 *  the renderer assigns them in subject-order and wraps modulo 8.
		 *  `unmatched` is the muted disc colour for entities outside the
		 *  pattern. `edge.matched` / `edge.unmatched` paint links inside vs.
		 *  outside the current pattern. Per the
		 *  [[apps-inherit-shell-theme]] memory: the graph app reads these
		 *  via CSS vars (no parallel palette in the app). */
		graph: {
			subject: {
				"1": string;
				"2": string;
				"3": string;
				"4": string;
				"5": string;
				"6": string;
				"7": string;
				"8": string;
			};
			unmatched: string;
			edge: {
				matched: string;
				unmatched: string;
			};
		};
	};
	space: {
		"0": string;
		"0_5": string;
		"1": string;
		"2": string;
		"3": string;
		"4": string;
		"5": string;
		"6": string;
		"7": string;
		"8": string;
	};
	text: {
		size: {
			xs: string;
			sm: string;
			md: string;
			lg: string;
			xl: string;
			"2xl": string;
			"3xl": string;
			display: string;
		};
		weight: {
			regular: string;
			medium: string;
			semibold: string;
			bold: string;
		};
		family: {
			ui: string;
			body: string;
			code: string;
			display: string;
		};
		lineHeight: {
			tight: string;
			normal: string;
			relaxed: string;
		};
	};
	/** Canonical interactive-control row-heights. Every form control that
	 *  sits on a toolbar/row line — buttons, text inputs, selects — sizes
	 *  its height from this scale so siblings line up pixel-exact and can
	 *  never drift. Never hardcode a control height in CSS. */
	control: {
		height: {
			sm: string;
			md: string;
			lg: string;
		};
	};
	radius: {
		none: string;
		xs: string;
		sm: string;
		md: string;
		lg: string;
		xl: string;
		full: string;
	};
	border: {
		width: string;
		widthThick: string;
	};
	shadow: {
		none: string;
		sm: string;
		md: string;
		lg: string;
		xl: string;
	};
	motion: {
		duration: {
			instant: string;
			fast: string;
			normal: string;
			slow: string;
			deliberate: string;
		};
		easing: {
			linear: string;
			standard: string;
			emphasized: string;
			decelerated: string;
		};
	};
	/** Backdrop-filter values for glass surfaces. Paired with `color.glass.*`. */
	glass: {
		blur: string;
		saturate: string;
	};
	z: {
		base: string;
		dropdown: string;
		sticky: string;
		overlay: string;
		modal: string;
		popover: string;
		toast: string;
		commandPalette: string;
		windowControlsOverlay: string;
	};
};

/**
 * Flatten a tokens object into `--token-path-flattened` CSS variable pairs.
 * Conversion: `color.background.primary` → `--color-background-primary`.
 * `0_5` is preserved as `0_5` (the dotted "half-step").
 */
export function flattenTokens(tokens: Tokens): Record<string, string> {
	const out: Record<string, string> = {};
	walk(tokens as unknown as Record<string, unknown>, [], out);
	return out;
}

function walk(node: Record<string, unknown>, path: string[], out: Record<string, string>): void {
	for (const [key, value] of Object.entries(node)) {
		const segment = camelToKebab(key);
		const nextPath = [...path, segment];
		if (typeof value === "string") {
			out[`--${nextPath.join("-")}`] = value;
		} else if (value && typeof value === "object") {
			walk(value as Record<string, unknown>, nextPath, out);
		}
	}
}

function camelToKebab(input: string): string {
	return input.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Deterministic palette pick for an app's fallback icon — the single
 * source of truth shared by BOTH the privileged dashboard renderer
 * (`renderer/dashboard/app-icon-palette.ts` re-exports it) and the
 * sandboxed-app preload (`preload/app-theme.ts` resolves the injected
 * `.app-header__icon` chip gradient from it). The same app id always
 * maps to the same gradient so the in-app header chip matches the
 * dashboard tile for that app, and the user's "where's the green one"
 * mental model holds.
 *
 * COCO-style palette: soft pastel two-stop gradients, low saturation,
 * matched lightness across hues so the suite reads as siblings. The
 * first-party apps reuse the first entries (coral / sage / violet /
 * cornflower) so unbranded third-party apps land in the same colour
 * family. Initials are white at ~92% opacity for soft on-gradient feel.
 */

export type IconGradient = {
	/** Top-left highlight stop. */
	from: string;
	/** Bottom-right body stop. */
	to: string;
	/** Initials colour — chosen for AA contrast against `to`. */
	ink: string;
};

const PALETTE: readonly IconGradient[] = [
	{ from: "#f5cdb6", to: "#e0815f", ink: "#ffffff" },
	{ from: "#a6e2d2", to: "#4faa92", ink: "#ffffff" },
	{ from: "#cdb9f4", to: "#8867d0", ink: "#ffffff" },
	{ from: "#b8d4f5", to: "#5491cf", ink: "#ffffff" },
	{ from: "#f3c9d8", to: "#c66a8c", ink: "#ffffff" },
	{ from: "#e8d8b4", to: "#b89150", ink: "#ffffff" },
];

const FALLBACK: IconGradient = { from: "#cdb9f4", to: "#8867d0", ink: "#ffffff" };

export function gradientFor(seed: string): IconGradient {
	const idx = hash32(seed) % PALETTE.length;
	return PALETTE[idx] ?? FALLBACK;
}

function hash32(input: string): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h;
}

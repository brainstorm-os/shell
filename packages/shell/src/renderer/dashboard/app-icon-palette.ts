/**
 * Deterministic palette pick for an app's fallback icon — used when the
 * manifest doesn't supply an icon asset.
 *
 * The palette + `gradientFor` now live in `shared/app-icon-palette.ts`
 * so the sandboxed-app preload (which injects the in-app header chip
 * gradient) and this dashboard renderer resolve the SAME gradient for a
 * given app id. This module re-exports them so existing renderer imports
 * (and their tests) keep working unchanged, and owns `initialsFor`,
 * which only the dashboard tile needs.
 */

export { type IconGradient, gradientFor } from "@brainstorm-os/protocol/app-icon-palette";

/** Up to two letters: first letter of the first two words, or the first
 *  two letters of a single word. Strips punctuation so `io.example.foo`
 *  collapses to `IE` from "Example Foo" or just `FO` from `foo`. */
export function initialsFor(name: string): string {
	const cleaned = name
		.replace(/[._\-/]+/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 0);
	if (cleaned.length === 0) return "•";
	if (cleaned.length === 1) {
		const word = cleaned[0] ?? "";
		return word.slice(0, 2).toUpperCase();
	}
	const first = cleaned[0]?.[0] ?? "";
	const second = cleaned[1]?.[0] ?? "";
	return `${first}${second}`.toUpperCase();
}

/**
 * createEntityIconElement — the ONE DOM primitive every non-React app uses
 * to render an object's own universal icon next to its name. The React
 * shell/Notes surfaces use `<EntityIcon>`; this is its imperative twin so
 * Files / Tasks / Whiteboard / Bookmarks / Journal / Database all paint an
 * object's icon identically (per
 * §Per-object icons everywhere — the object's OWN icon, type glyph as
 * fallback only).
 *
 * Fully self-styled (inline) so it renders identically regardless of which
 * app's stylesheet is loaded; callers only choose the pixel `size` and the
 * `fallback` node (their type glyph) for the icon-less / pack / load-fail
 * cases. Pack glyphs need the Phosphor dataset that DOM apps don't bundle,
 * so they degrade to the fallback — the correct degraded rendering.
 */

import type { Icon } from "@brainstorm-os/sdk-types";
import { IconKind } from "@brainstorm-os/sdk-types";

export type { Icon } from "@brainstorm-os/sdk-types";

export type EntityIconInput = Icon | null | undefined;

const ICON_KINDS: ReadonlySet<string> = new Set<string>([
	IconKind.Pack,
	IconKind.Emoji,
	IconKind.Image,
]);

/** Validate a loosely-typed `properties.icon` blob into a universal
 *  `Icon`, or `null` when absent/malformed. The shared parser every
 *  non-React app uses to read an object's own icon off the vault
 *  snapshot (where `properties` is `Record<string, unknown>`) before
 *  handing it to `createEntityIconElement` — so the validation rule is
 *  defined once, not re-hand-rolled per app. */
export function parseIcon(raw: unknown): Icon | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as { kind?: unknown; value?: unknown; color?: unknown };
	if (typeof obj.kind !== "string" || !ICON_KINDS.has(obj.kind)) return null;
	if (typeof obj.value !== "string" || !obj.value) return null;
	if (obj.kind === IconKind.Pack) {
		return typeof obj.color === "string" && obj.color
			? { kind: IconKind.Pack, value: obj.value, color: obj.color }
			: { kind: IconKind.Pack, value: obj.value };
	}
	if (obj.kind === IconKind.Image) {
		// Contract: an Image icon is a privileged `brainstorm://icon/<sha>`
		// URL (sdk-types/icon.ts). `properties.icon` is loosely-typed and
		// can be authored by a *different* sandboxed app; rejecting any
		// non-`brainstorm:` scheme here (the one shared chokepoint) stops a
		// hostile `https://…`/`data:` value from becoming a cross-app
		// `img.src` egress beacon when another app renders the object.
		return obj.value.startsWith("brainstorm:") ? { kind: IconKind.Image, value: obj.value } : null;
	}
	return { kind: IconKind.Emoji, value: obj.value };
}

export type CreateEntityIconOptions = {
	/** Pixel size of the glyph box. Default 16. */
	size?: number;
	/** Optional node rendered when there is no icon, the kind is pack, or an
	 *  image fails to load. Per [[feedback_no_default_type_icon_fallback]]:
	 *  an unset icon renders as NOTHING — no `·` dot, no type-default emoji,
	 *  and crucially no sized empty box: the helper returns `null` so the
	 *  surrounding layout's gap/column collapses around the missing slot.
	 *  Callers pass `fallback` only for explicit user-facing affordances
	 *  (e.g. the icon picker's "+" prompt); in that case the sized box is
	 *  preserved around the fallback node. */
	fallback?: () => Node;
};

export function createEntityIconElement(
	icon: EntityIconInput,
	options: CreateEntityIconOptions = {},
): HTMLElement | null {
	const size = options.size ?? 16;

	if ((!icon || typeof icon !== "object") && !options.fallback) return null;

	const wrap = document.createElement("span");
	wrap.setAttribute("aria-hidden", "true");
	wrap.style.display = "inline-flex";
	wrap.style.flex = "none";
	wrap.style.alignItems = "center";
	wrap.style.justifyContent = "center";
	wrap.style.width = `${size}px`;
	wrap.style.height = `${size}px`;
	wrap.style.lineHeight = "1";
	wrap.style.fontSize = `${Math.round(size * 0.86)}px`;

	const renderFallback = (): HTMLElement | null => {
		if (!options.fallback) return null;
		wrap.dataset.entityIconKind = "fallback";
		wrap.replaceChildren(options.fallback());
		return wrap;
	};

	if (!icon || typeof icon !== "object") return renderFallback();

	if (icon.kind === IconKind.Emoji && typeof icon.value === "string" && icon.value) {
		wrap.dataset.entityIconKind = "emoji";
		// Pin a colour-emoji font ahead of the app's UI stack. The app
		// token stack (`-apple-system, "Inter", "Segoe UI", Roboto`) has no
		// emoji face, so an inherited font renders the codepoint as a
		// notdef/"broken" box. This primitive is contractually self-styled
		// (renders identically in any app), so the emoji face must be set
		// here, not left to whichever stylesheet happens to be loaded.
		wrap.style.fontFamily =
			'"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';
		// Colour-emoji fonts ship asymmetric em-boxes (more ascender than
		// descender — the visible glyph sits above the line-box center).
		// `align-items: center` only centers the LINE-BOX, not the visible
		// glyph, so a Phosphor SVG renders 14×14 flush while an emoji of
		// the same size visibly floats. Wrapping the codepoint in an
		// inline-block we can transform corrects the offset without
		// changing the box model; the empirical 8% nudge lands the visual
		// centre of the glyph on the flex centre in every shipping colour-
		// emoji font we've tested.
		const inner = document.createElement("span");
		inner.style.display = "inline-block";
		inner.style.lineHeight = "1";
		inner.style.transform = "translateY(8%)";
		inner.textContent = icon.value;
		wrap.replaceChildren(inner);
		return wrap;
	}

	if (icon.kind === IconKind.Image && typeof icon.value === "string" && icon.value) {
		wrap.dataset.entityIconKind = "image";
		const img = document.createElement("img");
		img.src = icon.value;
		img.alt = "";
		img.draggable = false;
		img.width = size;
		img.height = size;
		img.style.width = `${size}px`;
		img.style.height = `${size}px`;
		img.style.objectFit = "cover";
		img.style.borderRadius = "4px";
		img.addEventListener(
			"error",
			() => {
				if (options.fallback) {
					renderFallback();
					return;
				}
				// No fallback: image failed AFTER the wrap was inserted into
				// the DOM, so we can't retroactively return null — hide the
				// sized box so the surrounding layout's gap collapses around
				// what is now an absent slot.
				wrap.style.display = "none";
				wrap.replaceChildren();
				wrap.dataset.entityIconKind = "fallback";
			},
			{ once: true },
		);
		wrap.appendChild(img);
		return wrap;
	}

	return renderFallback();
}

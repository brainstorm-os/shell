/**
 * EntityIcon — single rendering primitive for every `Icon` shape (pack /
 * emoji / image). Per, every entity-
 * like surface in the shell routes through this; no inline `<img>` or
 * inline `<PhosphorComponent>` outside of this file (the dashboard
 * `<AppIcon>` is the legacy exception — it renders APP icons specifically
 * and predates the universal model).
 *
 * Fallback chain:
 *   icon=null            → render `fallback`, else null (no box, no space)
 *   image: 404 / decode  → render `fallback`, else null
 *   pack: glyph missing  → render `fallback`, else null
 *
 * Per [[feedback_no_default_type_icon_fallback]] an unset icon renders as
 * NOTHING — no `·` dot, no type-default emoji, and (project-wide rule, not
 * just in DB) no sized empty box: the component returns `null` so the
 * surrounding layout's gap/column collapses around the missing slot.
 * Callers only pass an explicit `fallback` for user-action affordances
 * (icon picker "+", dashboard pin opener identity, etc.) — in that case
 * the sized box is preserved around the fallback node.
 *
 * Sizing is the caller's responsibility — `size` is pixel size of the
 * visible glyph; the component renders a `display: inline-block` box of
 * that size.
 */

import type { Icon } from "@brainstorm-os/sdk-types";
import { IconKind } from "@brainstorm-os/sdk-types";
import { useState } from "react";
import { emojiUrl } from "./emoji-set";
import { resolvePackGlyph } from "./icon-packs";

export type EntityIconProps = {
	icon: Icon | null;
	size?: number;
	/** Tailwind-style classnames or className for the outer span. */
	className?: string;
	/** What to render when `icon === null` or resolution fails. */
	fallback?: React.ReactNode;
	/** Inline style for the outer span (z-index, margin etc.). */
	style?: React.CSSProperties;
};

export function EntityIcon({
	icon,
	size = 16,
	className,
	fallback,
	style,
}: EntityIconProps): React.ReactElement | null {
	const [imageFailed, setImageFailed] = useState(false);

	if (!icon) return renderFallback(fallback, size, className, style);

	if (icon.kind === IconKind.Emoji) {
		return (
			<img
				className={className}
				src={emojiUrl(icon.value)}
				alt=""
				width={size}
				height={size}
				draggable={false}
				style={{ display: "inline-block", ...style }}
			/>
		);
	}

	if (icon.kind === IconKind.Image) {
		if (imageFailed) return renderFallback(fallback, size, className, style);
		return (
			<img
				className={className}
				src={icon.value}
				alt=""
				width={size}
				height={size}
				draggable={false}
				onError={() => setImageFailed(true)}
				style={{ display: "inline-block", objectFit: "cover", borderRadius: 4, ...style }}
			/>
		);
	}

	// Pack
	const glyph = resolvePackGlyph(icon.value);
	if (!glyph) return renderFallback(fallback, size, className, style);
	const Glyph = glyph.comp;
	return (
		<span
			className={className}
			style={{
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: size,
				height: size,
				color: icon.color ?? "currentColor",
				...style,
			}}
		>
			<Glyph size={size} weight="regular" />
		</span>
	);
}

function renderFallback(
	fallback: React.ReactNode | undefined,
	size: number,
	className: string | undefined,
	style: React.CSSProperties | undefined,
): React.ReactElement | null {
	if (fallback === undefined || fallback === null) return null;
	return (
		<span
			className={className}
			style={{
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: size,
				height: size,
				...style,
			}}
		>
			{fallback}
		</span>
	);
}

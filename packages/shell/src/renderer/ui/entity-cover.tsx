/**
 * EntityCover — single rendering primitive for an object's wide banner
 * cover (image / gradient / colour), the visual companion to
 * `<EntityIcon>`. Per every card /
 * header surface in the shell routes through this; no inline `<img>` for
 * a cover in feature code.
 *
 * The cover is read off the object's reserved universal `properties.cover`
 * (never keyed off `entity.type` — the rejected anti-pattern, same as
 * icons). Resolution + focal geometry + the id-seeded fallback live in
 * the shared pure keystone `@brainstorm-os/sdk/entity-cover`, so this
 * component and the non-React `createEntityCoverElement` twin paint
 * identically.
 *
 * Fallback chain:
 *   no cover            → id-seeded deterministic gradient
 *   image 404 / decode  → id-seeded deterministic gradient
 * Never a broken-image square.
 *
 * Aspect is the caller's responsibility — the layout chrome cell
 *  owns the per-context band height.
 */

import type { Cover } from "@brainstorm-os/sdk-types";
import {
	CoverRenderKind,
	type CoverSubject,
	DEFAULT_COVER_ASPECT,
	resolveCoverBackground,
} from "@brainstorm-os/sdk/entity-cover";
import { useRef, useState } from "react";

export type EntityCoverProps = {
	/** The object whose own cover to paint — its `id` seeds the fallback
	 *  gradient, its `properties.cover` is the explicit cover. */
	subject: CoverSubject;
	/** Per-view override (the documented `view.coverProperty` precedence,
	 *  OQ-COV-1). Omit to read the object's universal `properties.cover`. */
	cover?: Cover | null;
	/** Display aspect ratio (width / height). Default 16/9. */
	aspect?: number;
	/** Border radius in px. Default 0. */
	radius?: number;
	className?: string;
	style?: React.CSSProperties;
};

export function EntityCover({
	subject,
	cover,
	aspect,
	radius,
	className,
	style,
}: EntityCoverProps) {
	const [imageFailed, setImageFailed] = useState(false);
	// A subject / cover change must clear a stale failure flag, else a new
	// (valid) image stays hidden behind the previous one's fallback.
	// Adjusting state during render (vs. an effect) is the documented
	// React pattern for "reset state when a prop changes" — no extra
	// commit, no exhaustive-deps surface.
	const coverKey =
		cover === undefined
			? `auto:${subject.id}`
			: `${subject.id}:${cover ? cover.kind + cover.value : "none"}`;
	const lastKeyRef = useRef(coverKey);
	if (lastKeyRef.current !== coverKey) {
		lastKeyRef.current = coverKey;
		if (imageFailed) setImageFailed(false);
	}

	const resolved = resolveCoverBackground(subject, cover === undefined ? undefined : cover);
	const box: React.CSSProperties = {
		display: "block",
		width: "100%",
		aspectRatio: String(aspect && aspect > 0 ? aspect : DEFAULT_COVER_ASPECT),
		overflow: "hidden",
		borderRadius: radius ?? 0,
		...style,
	};

	if (resolved.kind === CoverRenderKind.Paint || imageFailed) {
		const css = resolved.kind === CoverRenderKind.Paint ? resolved.css : resolved.fallbackCss;
		return (
			<div
				className={className}
				aria-hidden="true"
				data-entity-cover-kind="paint"
				style={{ ...box, background: css }}
			/>
		);
	}

	return (
		<div className={className} aria-hidden="true" data-entity-cover-kind="image" style={box}>
			<img
				src={resolved.url}
				alt=""
				draggable={false}
				loading="lazy"
				decoding="async"
				onError={() => setImageFailed(true)}
				style={{
					width: "100%",
					height: "100%",
					objectFit: "cover",
					objectPosition: resolved.position,
					display: "block",
				}}
			/>
		</div>
	);
}

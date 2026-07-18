/**
 * Spinner — the design-system primitive for every async-loading affordance.
 * Canonical spec: §Async loading & busy state.
 *
 * Any control that fires an async request and any region whose content is
 * loading shows this — nothing async sits visually idle while work is in
 * flight. It renders as a rotating ring in the theme's border tone
 * (`--color-border-default`), so it reads correctly on every theme and
 * surface. No surface re-implements loader chrome — every consumer goes
 * through this primitive. Per CLAUDE.md DRY rule.
 *
 * Usage:
 *   <Spinner />                          inline, tracks font size
 *   <Spinner size={32} />                region-level loader
 *   <Spinner decorative />               inside a control that already
 *                                        announces aria-busy
 */

import type { CSSProperties } from "react";
import { t } from "../i18n/t";
import "./spinner.css";

export type SpinnerProps = {
	/**
	 * Pixel size. Omit to track the surrounding font size (`1em`) so it
	 * sits inline in a button or label.
	 */
	size?: number;
	/**
	 * Accessible label announced to assistive tech. Defaults to the
	 * localized "Loading…". Ignored when `decorative`.
	 */
	label?: string;
	/**
	 * Hide from the accessibility tree. Use when an ancestor already
	 * announces the busy state (e.g. a button with `aria-busy`), so the
	 * loader isn't double-announced.
	 */
	decorative?: boolean;
	className?: string;
	"data-testid"?: string;
};

export function Spinner({
	size,
	label,
	decorative = false,
	className,
	"data-testid": testId,
}: SpinnerProps) {
	// fontSize mirrors the pixel size so the em-scaled ring thickness
	// grows with region-level loaders instead of staying hairline.
	const style: CSSProperties | undefined =
		size === undefined ? undefined : { width: size, height: size, fontSize: size };
	const a11y = decorative
		? ({ "aria-hidden": true } as const)
		: ({ role: "status", "aria-label": label ?? t("shell.common.loading") } as const);
	return (
		<span
			className={className ? `spinner ${className}` : "spinner"}
			style={style}
			data-testid={testId}
			{...a11y}
		/>
	);
}

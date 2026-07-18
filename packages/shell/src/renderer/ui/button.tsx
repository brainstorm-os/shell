/**
 * Button — the design-system primitive for every text button in the app.
 * Builds on the same token-driven hover/active treatment as IconButton.
 *
 * Variants:
 *   Glass        — glossy theme-accent fill (same specular treatment as
 *                  Primary/Destructive), the canonical "button on any
 *                  surface" treatment. Use this by default.
 *   Primary      — solid accent fill, reserved for the single most
 *                  important action in a surface (rare).
 *   Neutral      — glossy inverse-surface fill (light on dark themes,
 *                  dark on light themes) used as the non-accent partner
 *                  in confirm dialogs and other "Cancel vs Primary"
 *                  pairs. Same specular treatment as Glass/Primary, but
 *                  a different face colour so it recedes next to the
 *                  accent CTA without reading as a flat black chip.
 *   Ghost        — invisible until hover; for tertiary actions inside
 *                  dense surfaces (toolbars, lists).
 *   Destructive  — accent for irreversible actions (delete, revoke).
 *
 * Sizes mirror IconButton (Md 32, Lg 40 row-height). Sm was removed
 * 2026-07-18 (owner call: the 24px face read cramped everywhere) — dense
 * surfaces use Md; genuinely icon-only tight spots use IconButton.
 *
 * No surface re-implements button chrome — every consumer goes through
 * this primitive. Per CLAUDE.md DRY rule.
 */

import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { forwardRef } from "react";
import { useShortcutLabel } from "../shortcuts/use-shortcut-label";
import { Icon, type IconName } from "./icon";
import { Spinner } from "./spinner";
import "./button.css";

export enum ButtonVariant {
	Glass = "glass",
	Primary = "primary",
	Neutral = "neutral",
	Ghost = "ghost",
	Destructive = "destructive",
}

export enum ButtonSize {
	Md = "md",
	Lg = "lg",
}

export type ButtonProps = {
	children: ReactNode;
	onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
	variant?: ButtonVariant;
	size?: ButtonSize;
	disabled?: boolean;
	/**
	 * Async request in flight. Shows the loader centered over the label
	 * (the button keeps its size), blocks `onClick`, and sets
	 * `aria-busy`. Per §Async loading.
	 */
	loading?: boolean;
	iconLeft?: IconName;
	iconRight?: IconName;
	/**
	 * Mark a destructive action. On a `Ghost` button it tints the label red
	 * (the quiet "Delete / Remove / Clear" secondary in a dialog footer) so
	 * destructive intent reads consistently without a second filled button
	 * competing with the primary. No-op on filled variants — use
	 * `ButtonVariant.Destructive` when the destructive action IS the primary.
	 */
	danger?: boolean;
	/**
	 * Shortcut-registry id (e.g. `"shell/launcher"`). When set:
	 *   1. The button renders the platform-formatted chord as a `<kbd>`
	 *      hint inside the label (right-aligned, secondary style).
	 *   2. The canonical chord string is stamped on `aria-keyshortcuts`
	 *      so assistive tech announces the binding without parsing the
	 *      visual glyphs.
	 * Unknown ids / unbound actions render no hint (no empty `<kbd>`).
	 * Per 24-keyboard-shortcuts.md — Stage 6.10d.
	 */
	shortcutId?: string;
	type?: "button" | "submit" | "reset";
	title?: string;
	className?: string;
	style?: CSSProperties;
	"data-testid"?: string;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{
		children,
		onClick,
		variant = ButtonVariant.Glass,
		size = ButtonSize.Md,
		disabled = false,
		loading = false,
		iconLeft,
		iconRight,
		danger = false,
		shortcutId,
		type = "button",
		title,
		className,
		style,
		"data-testid": testId,
	},
	ref,
) {
	const classes = ["button", `button--${variant}`, `button--${size}`];
	if (danger) classes.push("button--danger");
	if (loading) classes.push("button--loading");
	if (className) classes.push(className);
	const iconSize = size === ButtonSize.Md ? 14 : size === ButtonSize.Lg ? 20 : 16;
	const shortcut = useShortcutLabel(shortcutId ?? "");
	const showHint = shortcutId !== undefined && shortcut !== null;
	return (
		<button
			ref={ref}
			type={type}
			className={classes.join(" ")}
			onClick={loading ? undefined : onClick}
			disabled={disabled || loading}
			aria-busy={loading || undefined}
			aria-keyshortcuts={showHint ? shortcut.chord : undefined}
			title={title}
			data-testid={testId}
			style={style}
		>
			<span className="button__gloss" aria-hidden="true" />
			{iconLeft && (
				<span className="button__icon" aria-hidden="true">
					<Icon name={iconLeft} size={iconSize} />
				</span>
			)}
			<span className="button__label">{children}</span>
			{iconRight && (
				<span className="button__icon" aria-hidden="true">
					<Icon name={iconRight} size={iconSize} />
				</span>
			)}
			{showHint && (
				<span className="button__shortcut" aria-hidden="true">
					{shortcut.tokens.map((token) => (
						// Tokens are unique within a chord (a chord can't repeat a
						// modifier), so the value itself is a stable key.
						<kbd key={token} className="button__key">
							{token}
						</kbd>
					))}
				</span>
			)}
			{loading && (
				<span className="button__spinner">
					<Spinner decorative />
				</span>
			)}
		</button>
	);
});

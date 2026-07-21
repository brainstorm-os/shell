/**
 * Pure CSS-geometry affordances — disclosure caret + directional arrow.
 *
 * SHARED-PACKAGE GAP (flagged, not a fork): the B-2 SDK `<Icon>` set is
 * *exactly* the shell `IconName` enum and deliberately ships **no**
 * chevron / arrow-left / arrow-right glyphs (verified against
 * `packages/sdk/src/icon/icon-registry.ts`). Per the shared-fundamentals
 * contract §C an app must *flag* a needed glyph, never hand-edit the
 * generated SDK icon family. These are therefore drawn as geometric
 * affordances (a rotated chevron stroke), not a re-implemented inline-
 * SVG icon family — they carry no glyph identity, only a direction. When
 * the SDK icon set gains chevron/arrow names this file is deleted and
 * the call sites move to `<Icon>` (a one-import swap). Tracked as the
 * 9.8.2b shared-package STOP item in the build report.
 *
 * The panel-toggle glyph that used to live here moved to
 * `@brainstorm-os/sdk/panel-toggle` once we hit the 7th copy — now the only
 * source, used by every first-party app.
 */

export enum CaretDirection {
	Right = "right",
	Down = "down",
	Left = "left",
}

export function Caret({
	direction,
	size = 12,
}: {
	direction: CaretDirection;
	size?: number;
}) {
	const rotate =
		direction === CaretDirection.Down ? 45 : direction === CaretDirection.Left ? -135 : -45;
	const stroke = Math.max(1, Math.round(size / 8));
	const arm = size * 0.42;
	return (
		<span
			aria-hidden="true"
			style={{
				display: "inline-block",
				width: size,
				height: size,
				position: "relative",
			}}
		>
			<span
				style={{
					position: "absolute",
					top: "50%",
					left: "50%",
					width: arm,
					height: arm,
					borderRight: `${stroke}px solid currentColor`,
					borderBottom: `${stroke}px solid currentColor`,
					transform: `translate(-50%, -50%) rotate(${rotate}deg)`,
				}}
			/>
		</span>
	);
}

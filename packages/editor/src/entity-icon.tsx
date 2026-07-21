/**
 * `<EntityIcon>` — Notes' React mounting shim over the SDK's shared
 * object-icon primitive. The validation + emoji/image rendering + the
 * cross-app `img.src` egress guard all live in `@brainstorm-os/sdk/entity-icon`
 * (`parseIcon` + `createEntityIconElement`) — this file is *not* a second
 * implementation of that logic, it is the React twin the SDK's docstring
 * explicitly anticipates: it mounts the SDK DOM element into the React
 * tree and adds nothing the SDK doesn't already own.
 *
 * The one branch the SDK DOM helper deliberately can't render is Phosphor
 * *pack* glyphs (the dataset isn't bundled in DOM-only apps, so it
 * degrades to the fallback). Notes already depends on the lazy
 * `@brainstorm-os/sdk/icon-picker` Phosphor-React chunk for its icon picker,
 * so pack icons are kept here via that same shared chunk — a colour-true
 * pack glyph in a mention / page-ref, not a degraded dot. Everything
 * else (emoji, image, missing) goes straight through the SDK element.
 */

import { IconKind } from "@brainstorm-os/sdk-types";
import { type Icon, createEntityIconElement, parseIcon } from "@brainstorm-os/sdk/entity-icon";
import {
	loadPhosphorReact,
	subscribePhosphorReact,
	tryGetPhosphorComponent,
} from "@brainstorm-os/sdk/icon-picker";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export type EntityIconProps = {
	icon: Icon | null;
	size?: number;
	className?: string;
	fallback?: React.ReactNode;
	style?: React.CSSProperties;
};

export function EntityIcon({
	icon,
	size = 16,
	className,
	fallback,
	style,
}: EntityIconProps): React.ReactElement | null {
	const parsed = parseIcon(icon);

	if (parsed && parsed.kind === IconKind.Pack) {
		return (
			<PackIcon icon={parsed} size={size} className={className} style={style} fallback={fallback} />
		);
	}

	if (parsed) {
		return <SdkEntityIcon icon={parsed} size={size} className={className} style={style} />;
	}

	return renderFallback(fallback, size, className, style);
}

/** Mount the SDK's self-styled DOM element (emoji / image / its own
 *  fallback) into the React tree. The SDK owns the parse result, the
 *  emoji-font pin, and the image-egress guard — we only host it. */
function SdkEntityIcon({
	icon,
	size,
	className,
	style,
}: {
	icon: Icon;
	size: number;
	className?: string | undefined;
	style?: React.CSSProperties | undefined;
}) {
	const hostRef = useRef<HTMLSpanElement | null>(null);
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const el = createEntityIconElement(icon, { size });
		if (el) host.replaceChildren(el);
		else host.replaceChildren();
		return () => host.replaceChildren();
	}, [icon, size]);
	return (
		<span
			ref={hostRef}
			className={className}
			style={{ display: "inline-flex", lineHeight: 1, ...style }}
		/>
	);
}

function PackIcon({
	icon,
	size,
	className,
	style,
	fallback,
}: {
	icon: { kind: IconKind.Pack; value: string; color?: string };
	size: number;
	className?: string | undefined;
	style?: React.CSSProperties | undefined;
	fallback?: React.ReactNode | undefined;
}) {
	const name = icon.value.split("/")[1] ?? icon.value;
	useSyncExternalStore(subscribePhosphorReact, phosphorTickSnapshot);
	useEffect(() => {
		void loadPhosphorReact();
	}, []);
	const Glyph = tryGetPhosphorComponent(name);
	if (!Glyph) return renderFallback(fallback, size, className, style);
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

let phosphorTick = 0;
function phosphorTickSnapshot(): number {
	return phosphorTick;
}
subscribePhosphorReact(() => {
	phosphorTick += 1;
});

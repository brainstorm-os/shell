/**
 * React glyph component for the Graph header / sidebar / canvas-overlay chrome
 * (9.13.16 React migration). For glyphs the shared SDK registry exposes it
 * delegates to `<Icon>` so the chrome matches the rest of the product; for the
 * graph-specific glyphs the registry lacks (filter / play-pause / panel toggle
 * / reset / path) it renders the local stroke-only paths inline.
 */

import { Icon } from "@brainstorm-os/sdk/icon";
import type { ReactElement } from "react";
import {
	GRAPH_LOCAL_ICON_PATHS,
	type GraphIconName,
	type GraphLocalIcon,
	isSharedGraphIcon,
} from "./icons";

export function GIcon({
	glyph,
	size = 16,
	className,
}: {
	glyph: GraphIconName;
	size?: number;
	className?: string;
}): ReactElement {
	if (isSharedGraphIcon(glyph)) {
		return <Icon name={glyph} size={size} {...(className !== undefined ? { className } : {})} />;
	}
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.25}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={className}
		>
			{GRAPH_LOCAL_ICON_PATHS[glyph as GraphLocalIcon].map((d) => (
				<path key={d} d={d} />
			))}
		</svg>
	);
}

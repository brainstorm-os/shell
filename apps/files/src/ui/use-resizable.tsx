/**
 * React ref-callback hook over the SDK's `attachResizable` DOM helper —
 * the sanctioned resizable-panel primitive (per the shared-fundamentals
 * contract §A). Drives a CSS custom property on `document.body` and
 * persists to localStorage; the handle carries `role="separator"` +
 * `tabindex="0"` for the keyboard path.
 */

import { attachResizable } from "@brainstorm-os/sdk/resizable";
import { useCallback, useRef } from "react";

export type UseResizableOptions = {
	side: "left" | "right";
	defaultWidth: number;
	min: number;
	max: number;
	storageKey: string;
	cssVar: string;
};

export function useResizable(opts: UseResizableOptions) {
	const cleanupRef = useRef<(() => void) | null>(null);
	const { side, defaultWidth, min, max, storageKey, cssVar } = opts;

	return useCallback(
		(node: HTMLDivElement | null) => {
			cleanupRef.current?.();
			cleanupRef.current = null;
			if (!node) return;
			const handle = attachResizable({
				handle: node,
				side,
				defaultWidth,
				min,
				max,
				storageKey,
				onWidth: (px) => {
					document.body.style.setProperty(cssVar, `${px}px`);
				},
			});
			cleanupRef.current = () => handle.destroy();
		},
		[side, defaultWidth, min, max, storageKey, cssVar],
	);
}

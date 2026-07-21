/**
 * In-surface ⋯ object-menu affordance for elements that are themselves
 * `<button>`s (event chips, month ribbons) — rendered as a `role="button"`
 * span so it nests validly inside the parent button. Opens the shared
 * `openObjectMenu` anchored at its own rect. Keyboard via the shared chord
 * matcher (Enter / Space).
 */

import { type ObjectMenuContext, openObjectMenu } from "@brainstorm-os/sdk/object-menu";
import { matchesChord } from "@brainstorm-os/sdk/shortcut";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useRef } from "react";

const MORE_BUTTON_GAP = 4;

export type MoreButtonProps = {
	context: () => ObjectMenuContext;
	label: string;
	className?: string;
};

export function MoreButton({ context, label, className }: MoreButtonProps) {
	const ref = useRef<HTMLSpanElement>(null);

	const open = useCallback(() => {
		const el = ref.current;
		const ctx = context();
		if (!el || !ctx) return;
		const r = el.getBoundingClientRect();
		void openObjectMenu({ x: r.left, y: r.bottom + MORE_BUTTON_GAP }, { ...ctx, anchor: el });
	}, [context]);

	const onClick = useCallback(
		(event: ReactMouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			open();
		},
		[open],
	);

	const onKeyDown = useCallback(
		(event: ReactKeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (matchesChord(event.nativeEvent, "Enter") || matchesChord(event.nativeEvent, "Space")) {
				event.preventDefault();
				event.stopPropagation();
				open();
			}
		},
		[open],
	);

	return (
		<span
			ref={ref}
			role="button"
			tabIndex={0}
			className={className ? `bs-object-menu__more ${className}` : "bs-object-menu__more"}
			aria-haspopup="menu"
			aria-label={label}
			data-bs-tooltip={label}
			onClick={onClick}
			onKeyDown={onKeyDown}
		>
			<span className="bs-object-menu__more-dot" />
			<span className="bs-object-menu__more-dot" />
			<span className="bs-object-menu__more-dot" />
		</span>
	);
}

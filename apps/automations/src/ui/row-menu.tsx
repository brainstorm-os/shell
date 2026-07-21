import { MenuAlign } from "@brainstorm-os/sdk/menus";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { type ReactElement, useRef } from "react";

/** Trailing hover-revealed ⋯ overflow holding a row's actions — the same
 *  shared object-menu chrome (`.bs-object-menu__more` + `openAnchoredMenu`)
 *  every other app uses for per-row actions, so the menu is pixel-identical.
 *  Right-aligns to the trigger's edge (`MenuAlign.End`). */
export function RowMenu({
	menuLabel,
	items,
}: {
	menuLabel: string;
	items: AnchoredMenuItem[];
}): ReactElement {
	const moreRef = useRef<HTMLButtonElement>(null);

	const open = (): void => {
		const anchor = moreRef.current;
		if (!anchor) return;
		const rect = anchor.getBoundingClientRect();
		openAnchoredMenu({ x: rect.right, y: rect.bottom }, items, {
			menuLabel,
			anchor,
			align: MenuAlign.End,
		});
	};

	return (
		<button
			ref={moreRef}
			type="button"
			className="bs-object-menu__more au-row__more"
			aria-haspopup="menu"
			aria-label={menuLabel}
			data-bs-tooltip={menuLabel}
			onClick={(event) => {
				event.stopPropagation();
				open();
			}}
		>
			<span className="bs-object-menu__more-dot" />
			<span className="bs-object-menu__more-dot" />
			<span className="bs-object-menu__more-dot" />
		</button>
	);
}

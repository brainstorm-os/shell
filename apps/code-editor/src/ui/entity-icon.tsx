/**
 * The object's own universal icon, rendered through the shared imperative
 * primitive (the SDK has no React entity-icon outside `@brainstorm-os/editor`,
 * which this app deliberately does not depend on). Shared by the header
 * identity chip and the file-tree rows.
 */

import {
	type Icon as EntityIconValue,
	createEntityIconElement,
} from "@brainstorm-os/sdk/entity-icon";
import { Icon, type IconName } from "@brainstorm-os/sdk/icon";
import { type ReactElement, useEffect, useRef } from "react";

export function EntityIcon({
	icon,
	size,
	fallback,
}: {
	icon: EntityIconValue | null;
	size: number;
	/** Glyph to paint when the object carries no icon of its own. Opt-in: the
	 *  header's icon-picker chip stays EMPTY without one (an empty chip is the
	 *  invitation to pick), while the tree rows always want a filled column. */
	fallback?: IconName;
}): ReactElement {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		host.replaceChildren();
		const element = createEntityIconElement(icon, { size });
		if (element) host.appendChild(element);
	}, [icon, size]);

	// The sidebar is a folder TREE, so — like the Files tree — its rows need an
	// icon column that is always occupied: without a fallback the names of
	// icon-less files step left and stop lining up with their siblings.
	//
	// The two branches carry distinct `key`s on purpose: they are the same
	// element type at the same position, and the icon-bearing one holds
	// imperatively-appended content React does not own. Without the keys React
	// would reuse the node across the flip and strand that content on top of
	// the fallback (the hybrid-reconciliation trap in CLAUDE.md).
	return icon === null && fallback !== undefined ? (
		<span key="type-fallback" className="editor__file-icon" aria-hidden="true">
			<Icon name={fallback} size={size} />
		</span>
	) : (
		<span key="own-icon" className="editor__file-icon" ref={ref} aria-hidden="true" />
	);
}

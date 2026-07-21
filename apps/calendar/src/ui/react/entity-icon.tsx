/**
 * Thin React wrapper over the SDK's imperative `createEntityIconElement`
 * (which returns a DOM node or `null`). The icon helper itself stays the
 * shared SDK primitive — this only mounts its output into a React-managed
 * span so chips / blocks / the detail surface can paint the per-object
 * icon. Renders nothing when the item has no icon (per
 * [[feedback_no_default_type_icon_fallback]]).
 */

import { type Icon, createEntityIconElement } from "@brainstorm-os/sdk/entity-icon";
import { useEffect, useRef } from "react";

export type EntityIconProps = {
	icon: Icon | null;
	size: number;
	className?: string;
};

export function EntityIcon({ icon, size, className }: EntityIconProps) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		const el = createEntityIconElement(icon ?? null, { size });
		if (el) {
			if (className) el.classList.add(className);
			host.replaceChildren(el);
			host.hidden = false;
		} else {
			host.replaceChildren();
			host.hidden = true;
		}
	}, [icon, size, className]);
	return <span ref={ref} aria-hidden="true" />;
}

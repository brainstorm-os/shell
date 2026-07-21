/**
 * Thin React wrapper over the SDK's imperative `createEntityIconElement`
 * (returns a DOM node or `null`). Renders the passive day-icon glyph on a
 * read-only surface (preview / standalone); the mutable surface uses the
 * shared `<IconPickerButton>` instead.
 */

import { type Icon, createEntityIconElement } from "@brainstorm-os/sdk/entity-icon";
import { useEffect, useRef } from "react";

export type EntityIconProps = {
	icon: Icon | null;
	size: number;
};

export function EntityIcon({ icon, size }: EntityIconProps) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		const el = createEntityIconElement(icon ?? null, { size });
		if (el) {
			host.replaceChildren(el);
			host.hidden = false;
		} else {
			host.replaceChildren();
			host.hidden = true;
		}
	}, [icon, size]);
	return <span ref={ref} aria-hidden="true" />;
}

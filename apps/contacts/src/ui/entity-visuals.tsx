/**
 * React wrappers over the SDK's sanctioned DOM twins
 * (`createEntityIconElement` / `createEntityCoverElement`) — the same
 * arrangement as Files' / Books' `ui/entity-visuals.tsx`: the SDK ships
 * `<EntityIcon>` / `<EntityCover>` only for the shell and Notes, and the
 * cross-app sanctioned surface is the imperative DOM twin (shared-fundamentals
 * contract §A), so each React app mounts that exact element into a ref.
 *
 * The icon renders only when the entity has its OWN (`Icon | null` in,
 * `null` → the host span stays empty) per
 * [[feedback_no_default_type_icon_fallback]].
 */

import type { Cover, Icon } from "@brainstorm-os/sdk-types";
import { type CoverSubject, createEntityCoverElement } from "@brainstorm-os/sdk/entity-cover";
import { createEntityIconElement } from "@brainstorm-os/sdk/entity-icon";
import { useEffect, useRef } from "react";

export type EntityIconProps = {
	icon: Icon | null;
	size?: number;
	className?: string;
};

export function EntityIcon({ icon, size = 16, className }: EntityIconProps) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		const el = createEntityIconElement(icon, { size });
		if (el) host.replaceChildren(el);
		else host.replaceChildren();
	}, [icon, size]);
	return <span ref={ref} className={className} aria-hidden="true" />;
}

export type EntityCoverProps = {
	subject: CoverSubject;
	/** The already-projected cover — passed explicitly (the Bookmarks
	 *  arrangement) so the band re-renders when the value changes without
	 *  re-reading the subject's property bag. */
	cover: Cover | null;
	aspect?: number;
	className?: string;
};

export function EntityCover({ subject, cover, aspect, className }: EntityCoverProps) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		host.replaceChildren(
			createEntityCoverElement(subject, aspect !== undefined ? { aspect } : {}, cover),
		);
	}, [subject, cover, aspect]);
	return <div ref={ref} className={className} aria-hidden="true" />;
}

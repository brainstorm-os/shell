/**
 * React wrappers over the SDK's sanctioned DOM twins
 * (`createEntityIconElement` / `createEntityCoverElement`).
 *
 * The SDK ships `<EntityIcon>` / `<EntityCover>` only for the shell and
 * Notes; the cross-app-sanctioned surface for every other app is the
 * imperative DOM twin (per the shared-fundamentals contract §A). These
 * thin components mount that exact element into a ref so Files renders
 * identical icon/cover output without forking the SDK helper.
 *
 * Per [[feedback_no_default_type_icon_fallback]] (project-wide) the icon
 * is rendered only when the entity has its OWN — callers pass
 * `readEntityIcon(entity)` (`Icon | null`) straight in; for a null value
 * the SDK returns `null` and the host span stays empty so the parent
 * layout's gap/column collapses around the missing slot (no sized box).
 */

import type { Icon } from "@brainstorm-os/sdk-types";
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
	aspect?: number;
	className?: string;
};

export function EntityCover({ subject, aspect, className }: EntityCoverProps) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		host.replaceChildren(createEntityCoverElement(subject, aspect !== undefined ? { aspect } : {}));
	}, [subject, aspect]);
	return <div ref={ref} className={className} aria-hidden="true" />;
}

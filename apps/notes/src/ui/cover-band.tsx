/**
 * CoverBand — React wrapper over the SDK's `createEntityCoverElement`
 * (the one cover renderer). Notes' tree is React; the SDK ships the
 * cover render as a DOM twin (the React `<EntityCover>` is shell-only),
 * so this mounts the DOM node and re-mounts when the subject's id or
 * cover changes. Never keyed off entity type — per-object-covers-
 * everywhere.
 */

import type { Cover } from "@brainstorm-os/sdk-types";
import { createEntityCoverElement } from "@brainstorm-os/sdk/entity-cover";
import { useEffect, useRef } from "react";

export type CoverBandProps = {
	subjectId: string;
	cover: Cover | null;
	/** Display aspect (width / height). Default a wide doc banner. */
	aspect?: number;
	radius?: number;
};

export function CoverBand({ subjectId, cover, aspect = 16 / 5, radius = 0 }: CoverBandProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const el = createEntityCoverElement(
			{ id: subjectId, properties: cover ? { cover } : {} },
			{ aspect, radius },
		);
		host.replaceChildren(el);
		return () => host.replaceChildren();
	}, [subjectId, cover, aspect, radius]);

	return <div ref={hostRef} className="notes__cover-host" />;
}

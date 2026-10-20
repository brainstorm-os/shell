import { useMemo, useRef, useState } from "react";
import { OsFileDragTracker, type OsFileDropOptions, createOsFileDropHandlers } from "./drop-target";

/** React twin of `bindOsFileDrop`: spread `dropProps` on the zone, read
 *  `isOver` for the hover affordance. Options are read through a ref, so an
 *  inline `onFiles` closure never goes stale and never re-creates handlers. */
export function useOsFileDrop(options: OsFileDropOptions) {
	const [isOver, setIsOver] = useState(false);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const dropProps = useMemo(() => {
		const tracker = new OsFileDragTracker((over) => {
			setIsOver(over);
			optionsRef.current.onOverChange?.(over);
		});
		return createOsFileDropHandlers(
			{
				onFiles: (files) => optionsRef.current.onFiles(files),
				get ignoreTypes(): readonly string[] {
					return optionsRef.current.ignoreTypes ?? [];
				},
				enabled: () => optionsRef.current.enabled?.() ?? true,
			},
			tracker,
		);
	}, []);
	return { isOver, dropProps };
}

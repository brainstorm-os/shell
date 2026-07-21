/**
 * ICS import / export header ⋯ button (React) — the trailing-edge catch-all.
 * Opens the shared fancy-menus anchored menu (Import / Export iCal); the
 * actual file work lives in the pure `ui/ics-actions` orchestrators.
 */

import { IconName } from "@brainstorm-os/sdk/icon";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { useRef } from "react";
import { t } from "../../i18n/t";
import type { CalendarFilesService } from "../../storage/runtime";
import type { Event } from "../../types/event";
import { exportEventsToIcs, importEventsFromIcs } from "../ics-actions";

export type IcsActionsButtonProps = {
	files: CalendarFilesService;
	getEvents: () => readonly Event[];
	onImport: (events: Event[]) => Promise<void> | void;
	notify?: (message: string) => void;
	/** Opens the CalDAV sync dialog (9.15.19); omitted when the shell does
	 *  not expose the `caldav` service. */
	onOpenCalDav?: () => void;
};

export function IcsActionsButton({
	files,
	getEvents,
	onImport,
	notify,
	onOpenCalDav,
}: IcsActionsButtonProps) {
	const ref = useRef<HTMLButtonElement>(null);

	const open = (): void => {
		const items: AnchoredMenuItem[] = [
			{
				label: t("calendar.actions.import"),
				icon: IconName.Inbox,
				onSelect: () => void importEventsFromIcs(files, onImport, notify),
			},
			{
				label: t("calendar.actions.export"),
				icon: IconName.Download,
				onSelect: () => void exportEventsToIcs(files, getEvents(), notify),
			},
			...(onOpenCalDav
				? [
						{
							label: t("calendar.actions.caldav"),
							icon: IconName.Update,
							onSelect: () => onOpenCalDav(),
						},
					]
				: []),
		];
		const el = ref.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		openAnchoredMenu({ x: r.left, y: r.bottom + 4 }, items, {
			menuLabel: t("calendar.actions.menu"),
			anchor: el,
		});
	};

	return (
		<button
			ref={ref}
			type="button"
			className="bs-object-menu__more cal-actions__more"
			aria-haspopup="menu"
			aria-label={t("calendar.actions.menu")}
			data-bs-tooltip={t("calendar.actions.menu")}
			onClick={open}
		>
			<span className="bs-object-menu__more-dot" />
			<span className="bs-object-menu__more-dot" />
			<span className="bs-object-menu__more-dot" />
		</button>
	);
}

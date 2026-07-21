/**
 * Builds the quick-look popover body — a definition list of the
 * `QuickLookSheet` rows. The popover chrome itself comes from the shared
 * `@brainstorm-os/sdk/popover` (`createPopoverElement`) in `app.ts`; this
 * only produces the body node so the layout is testable in isolation.
 */

import { t } from "../i18n/t";
import type { QuickLookSheet } from "../logic/quick-look";

export function renderQuickLookBody(sheet: QuickLookSheet): HTMLElement {
	const dl = document.createElement("dl");
	dl.className = "tasks-quicklook";

	if (sheet.rows.length === 0) {
		const empty = document.createElement("p");
		empty.className = "tasks-quicklook__empty";
		empty.textContent = t("tasks.quickLook.value.none");
		dl.appendChild(empty);
		return dl;
	}

	for (const row of sheet.rows) {
		const dt = document.createElement("dt");
		dt.className = "tasks-quicklook__label";
		dt.textContent = t(row.labelKey);
		const dd = document.createElement("dd");
		dd.className = "tasks-quicklook__value";
		dd.textContent = row.value;
		dl.append(dt, dd);
	}
	return dl;
}

/**
 * Calendar's `RecurrenceSummaryLabels` pack — feeds the shared
 * `summarizeRecurrence` keystone the app's translated phrases. The builder
 * lives in `@brainstorm-os/sdk/recurrence-labels` (shared with Tasks); this
 * wires it to the `calendar.recurrence.*` manifest namespace.
 */

import type { RecurrenceSummaryLabels } from "@brainstorm-os/sdk-types";
import { buildRecurrenceLabels } from "@brainstorm-os/sdk/recurrence-labels";
import { type TKey, t } from "./t";

export function recurrenceLabels(): RecurrenceSummaryLabels {
	return buildRecurrenceLabels((key, params) => t(`calendar.recurrence.${key}` as TKey, params));
}

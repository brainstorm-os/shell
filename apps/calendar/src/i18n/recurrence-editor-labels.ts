/**
 * Calendar → shared `<RecurrenceEditor>` label mapping. The editor behaviour +
 * DOM live in `@brainstorm-os/sdk/recurrence-editor`; this owns only the
 * Calendar-namespace label pack (the imperative `ui/recurrence-editor.ts`
 * adapter's job, now inlined for the React twin).
 */

import { RepeatKind } from "@brainstorm-os/sdk/recurrence-edit";
import type { RecurrenceEditorLabels } from "@brainstorm-os/sdk/recurrence-editor";
import { t } from "./t";

export function calendarRecurrenceEditorLabels(): RecurrenceEditorLabels {
	return {
		fieldLabel: t("calendar.detail.field.repeat"),
		kind: {
			[RepeatKind.None]: t("calendar.recurrence.kind.none"),
			[RepeatKind.Daily]: t("calendar.recurrence.kind.daily"),
			[RepeatKind.Weekly]: t("calendar.recurrence.kind.weekly"),
			[RepeatKind.Monthly]: t("calendar.recurrence.kind.monthly"),
			[RepeatKind.Yearly]: t("calendar.recurrence.kind.yearly"),
			[RepeatKind.Custom]: t("calendar.recurrence.kind.custom"),
		},
		editEvery: t("calendar.recurrence.editEvery"),
		unitDays: t("calendar.recurrence.unit.days"),
		unitWeeks: t("calendar.recurrence.unit.weeks"),
		unitMonths: t("calendar.recurrence.unit.months"),
		intervalLabel: t("calendar.recurrence.intervalLabel"),
		onDays: t("calendar.recurrence.onDays"),
		monthlyMode: t("calendar.recurrence.monthlyMode"),
		monthlyByDayLabel: t("calendar.recurrence.monthlyByDayLabel"),
		monthlyByWeekdayLabel: t("calendar.recurrence.monthlyByWeekdayLabel"),
		yearlyMonth: t("calendar.recurrence.yearlyMonth"),
		yearlyDay: t("calendar.recurrence.yearlyDay"),
		customLabel: t("calendar.recurrence.customLabel"),
		customPlaceholder: t("calendar.recurrence.customPlaceholder"),
	};
}

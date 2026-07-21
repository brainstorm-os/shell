/**
 * `@brainstorm-os/sdk/recurrence-editor` — the shared write-half of the
 * `Recurrence` union. Both the imperative `createRecurrenceEditor` (plain-DOM
 * apps) and the `RecurrenceEditor` React twin (Calendar, Tasks) live here on
 * one subpath, mirroring `@brainstorm-os/sdk/calendar` and `/date-pager`. The
 * React twin is tree-shaken out of imperative-only bundles (`sideEffects:
 * false`, React is an optional peer). CSS rides through
 * `@brainstorm-os/sdk/recurrence-editor.css`.
 */

export {
	createRecurrenceEditor,
	type RecurrenceEditorHandle,
	type RecurrenceEditorLabels,
	type RecurrenceEditorOptions,
} from "./recurrence-editor";

export { RecurrenceEditor, type RecurrenceEditorProps } from "./RecurrenceEditor";

/**
 * The shared SDK picker bridge. Database is plain DOM; the icon/cover
 * pickers are React and mounted through `@brainstorm-os/sdk/picker-host`
 * (one shared `react-dom/client` root + canonical `@brainstorm-os/sdk/i18n`
 * labels — formerly a per-app copy of this bridge with hardcoded
 * English). Re-exported here so the call sites in `app.ts` stay stable.
 */

export {
	openIconPicker,
	openCoverPicker,
	openInlinePropertyForm,
	closePicker,
	createIconPickerButton,
} from "@brainstorm-os/sdk/picker-host";

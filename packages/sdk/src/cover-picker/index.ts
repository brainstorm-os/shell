/**
 * `@brainstorm-os/sdk/cover-picker` — the ONE object-cover chooser, the
 * visual companion to `@brainstorm-os/sdk/icon-picker`. Host-agnostic
 * (labels + the `covers` content service are injected); renders inside
 * the host's overlay. See `entity-cover` for the render side.
 */

export {
	CoverPicker,
	type CoverPickerProps,
	type CoverPickerLabels,
	type CoverPickerService,
} from "./picker";
export { DEFAULT_COVER_PICKER_LABELS } from "../i18n/common-labels";

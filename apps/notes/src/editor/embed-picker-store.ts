/** Re-export shim — the embed-picker store now lives in `@brainstorm/editor`
 *  (F-070 embed parity: `<FullEditorPlugins>` mounts the picker for every
 *  host; Notes' type-scoped `/database` / `/graph` / `/book` commands open
 *  the same store with a `typeFilter`). */
export {
	type EmbedPickerTarget,
	embedPickerStore,
	openEntityEmbedPicker,
	useEmbedPickerTarget,
} from "@brainstorm/editor";

/**
 * `RichTextPropertyEditor` — the `richTextEditor` seam the SDK's RichText
 * property cell mounts (9.12.26), over the shared `<CompactEditor>`. A host
 * passes it to `<PropertiesProvider richTextEditor={RichTextPropertyEditor}>`;
 * the SDK can't import it directly (this package depends on the SDK).
 *
 * The property value keeps both halves of a compact-editor payload — the
 * serialized state (re-opened losslessly) and the plain-text projection (what
 * a grid cell, search and sort read). Enter is a paragraph break here, not a
 * submit: a property is a document fragment, not a chat message.
 */

import type { RichTextValue } from "@brainstorm-os/sdk-types";
import type { RichTextEditorProps } from "@brainstorm-os/sdk/property-ui";
import { type JSX, useCallback } from "react";
import { CompactEditor, type CompactEditorPayload } from "./compact-editor";

export function richTextValueFromPayload(payload: CompactEditorPayload): RichTextValue {
	return { text: payload.text, state: payload.state };
}

export function RichTextPropertyEditor({
	initialValue,
	ariaLabel,
	autoFocus = false,
	toolbar,
	onChange,
}: RichTextEditorProps): JSX.Element {
	const emit = useCallback(
		(payload: CompactEditorPayload) => onChange(richTextValueFromPayload(payload)),
		[onChange],
	);
	return (
		<CompactEditor
			className="bs-rich-text-property"
			ariaLabel={ariaLabel}
			autoFocus={autoFocus}
			toolbar={toolbar}
			submitOnEnter={false}
			onChange={emit}
			{...(initialValue?.state ? { initialState: initialValue.state } : {})}
			{...(initialValue?.text ? { initialText: initialValue.text } : {})}
		/>
	);
}

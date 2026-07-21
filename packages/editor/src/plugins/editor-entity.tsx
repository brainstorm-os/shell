/**
 * EditorEntity — read + write access to the host entity's property
 * values from inside the editor tree. Generalised from Notes'
 * former `NoteContext`: property blocks live on every editing surface
 * now ("properties can be used anywhere"), so the bridge belongs in the
 * shared package.
 *
 * The editor's built-in nodes (paragraph, heading, list…) don't need
 * this — their state lives in the Lexical tree itself. PropertyBlockNode
 * / PropertyListBlockNode are different: they hold only a ref to a
 * property key, and the actual value lives on the entity's `values` map.
 * Decorator components reach it through this context so the bridge isn't
 * prop-drilled through Lexical's render seams.
 *
 * Like the host + transclusion providers, this mounts ABOVE
 * `<BrainstormEditor>` so it reaches decorators that portal out of
 * `RichTextPlugin` (see [[project_lexical_decorator_context]]). The app
 * supplies `entityId`, the current `values` map, and a kind-narrowed
 * `setValue` callback.
 */

import type { PropertyDef, PropertyValueByValueType, ValueType } from "@brainstorm-os/sdk-types";
import type { ValuesMap } from "@brainstorm-os/sdk/property-ui/pure";
import { type ReactNode, createContext, useContext, useMemo } from "react";

export type EditorEntityContextValue = {
	entityId: string;
	values: ValuesMap;
	setValue: <V extends ValueType>(
		def: PropertyDef & { valueType: V },
		next: PropertyValueByValueType[V],
	) => void;
};

const EditorEntityContext = createContext<EditorEntityContextValue | null>(null);

export type EditorEntityProviderProps = EditorEntityContextValue & { children: ReactNode };

export function EditorEntityProvider(props: EditorEntityProviderProps) {
	const { entityId, values, setValue, children } = props;
	const value = useMemo<EditorEntityContextValue>(
		() => ({ entityId, values, setValue }),
		[entityId, values, setValue],
	);
	return <EditorEntityContext.Provider value={value}>{children}</EditorEntityContext.Provider>;
}

export function useEditorEntity(): EditorEntityContextValue {
	const ctx = useContext(EditorEntityContext);
	if (!ctx) {
		throw new Error("useEditorEntity: missing <EditorEntityProvider>");
	}
	return ctx;
}

/** Non-throwing variant — returns `null` outside a provider. Decorator
 *  fallbacks use this so they can render a degraded view (read-only
 *  preview) when mounted in a tree without an entity (e.g. tests that
 *  exercise just the node serialization layer). */
export function useEditorEntityOptional(): EditorEntityContextValue | null {
	return useContext(EditorEntityContext);
}

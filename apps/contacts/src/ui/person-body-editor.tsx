/**
 * PersonBodyEditor — the contact page's free-form notes surface: the SAME
 * editable `BrainstormEditor` (Lexical + Yjs) Notes / Journal / Tasks /
 * Bookmarks use, bound to the person entity's `brainstorm/UniversalBody/v1`
 * Y.Doc via `useYDoc(person.id)` and persisted through the shared
 * `entities.applyDoc` transport.
 *
 * First-open seeding: a contact created before the page editor existed (or
 * imported from a vCard NOTE) carries its content in the legacy `bio`
 * string. When present we pass an `initialEditorState` initialiser;
 * `CollaborationPlugin` calls it exactly once — when its sync settles on an
 * empty doc — so the plant is automatic, deterministic, and idempotent
 * across opens. `onFirstEdit` fires the first time the user actually edits,
 * letting the app clear the legacy `bio` so the body becomes the single
 * source of truth (same contract as Tasks' `notes` migration).
 */

import {
	AutosavePlugin,
	BrainstormEditor,
	FULL_EDITOR_NODES,
	FullEditorPlugins,
	plainTextToSerializedState,
	richTextTheme,
} from "@brainstorm/editor";
import {
	useUniversalBody,
	useYDoc,
	useYDocApplyPending,
	useYDocLoaded,
} from "@brainstorm/react-yjs";
import { $getRoot, type LexicalEditor, type SerializedEditorState } from "lexical";
import { useMemo } from "react";
import { t } from "../i18n";

export type PersonBodyEditorProps = {
	/** The person's stable entity id — resolved through the app-installed
	 *  YDocResolver. */
	personId: string;
	/** Legacy `bio` string to seed the body from on first open. Empty /
	 *  undefined when the contact has no legacy bio (or was already
	 *  migrated). */
	seedBio?: string;
	/** Fires the first time the body changes from a real user edit (the
	 *  AutosavePlugin only calls back after genuine interaction). The app
	 *  uses this to clear the legacy `bio` string once. */
	onFirstEdit?(): void;
};

export function PersonBodyEditor({ personId, seedBio, onFirstEdit }: PersonBodyEditorProps) {
	const doc = useYDoc(personId);
	const whenLoaded = useYDocLoaded(personId);
	const applyPending = useYDocApplyPending(personId);
	useUniversalBody(doc);

	// Build the seed initialiser once per seedBio value (the component is
	// keyed by person id at the call site, so a contact switch remounts and
	// recomputes anyway). The callback no-ops against a non-empty doc, so
	// re-opening a contact whose body already has content never re-plants
	// the legacy string.
	const initialEditorState = useMemo(() => {
		const text = seedBio?.trim();
		if (!text) return undefined;
		const state = plainTextToSerializedState(seedBio ?? "");
		return (editor: LexicalEditor) => {
			const root = $getRoot();
			if (!root.isEmpty()) return;
			try {
				editor.setEditorState(editor.parseEditorState(state));
			} catch (error) {
				console.warn("[contacts/body-editor] seed plant failed:", error);
			}
		};
	}, [seedBio]);

	const onChange = useMemo(() => {
		if (!onFirstEdit) return undefined;
		return (_state: SerializedEditorState) => onFirstEdit();
	}, [onFirstEdit]);

	return (
		<BrainstormEditor
			doc={doc}
			docId={personId}
			namespace="contacts"
			theme={richTextTheme}
			contentClassName="notes__contenteditable contacts-detail__editor"
			additionalNodes={FULL_EDITOR_NODES}
			placeholder={
				<span className="contacts-detail__body-placeholder">{t("detail.body.placeholder")}</span>
			}
			{...(initialEditorState ? { initialEditorState } : {})}
			{...(whenLoaded ? { whenLoaded } : {})}
			{...(applyPending ? { applyPending } : {})}
			onError={(error) => {
				console.error("[contacts/body-editor]", error);
			}}
		>
			<FullEditorPlugins
				docId={personId}
				currentEntityId={personId}
				scrollContainerSelector=".contacts-detail__scroll"
			>
				{onChange ? <AutosavePlugin onChange={onChange} /> : null}
			</FullEditorPlugins>
		</BrainstormEditor>
	);
}

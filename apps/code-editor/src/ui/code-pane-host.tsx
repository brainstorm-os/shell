/**
 * `<CodePaneHost>` — the React ref boundary around the imperative editing
 * island (`createCodePane`). The controller owns the `<textarea>` + Shiki
 * overlay + Y.Text binding + folding/multi-cursor/find, and must NOT be torn
 * down on a React re-render (that loses the caret / IME / fold state). So the
 * host mounts ONE controller for its lifetime, `update(row)` swaps the open
 * file in place, and the Y.Doc handle is acquired/released as the selection
 * changes — exactly the lifecycle the old `app.ts` `ensureCodePane` ran.
 *
 * The wrapper uses `display: contents` so the controller's `.editor__pane`
 * `<section>` is the effective grid child of `.editor`, preserving the exact
 * two-column layout the CSS expects.
 */

import type { YDocHandle, YDocResolverApi } from "@brainstorm/react-yjs";
import type { ObjectMenuContext } from "@brainstorm/sdk/object-menu";
import { type ForwardedRef, forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { CitationIndex } from "../logic/citation-index";
import type { CodeFileRow } from "../logic/code-projection";
import type { SyntaxThemePreference } from "../logic/syntax-theme";
import type { CitationOpen } from "./citation-hover";
import { type CodePaneController, type CodePaneLabels, createCodePane } from "./code-pane";
import type { DiffViewMode } from "./diff-view";

export type CodePaneHostHandle = {
	focus(): void;
	refresh(): void;
	/** The open file's rich object menu (file actions + editor toggles),
	 *  hoisted to the shell `.app-header` ⋯ so the pane needs no header bar. */
	menuContext(): ObjectMenuContext | null;
	formatBuffer(): Promise<boolean>;
	canFormatBuffer(): boolean;
	openFind(mode?: "find" | "find-replace"): void;
	foldAtCaret(): void;
	unfoldAtCaret(): void;
	unfoldAll(): void;
	toggleWrap(): void;
	/** Best-effort reveal of a 1-based line in the open buffer. */
	revealLine(line: number): void;
	/** Toggle the read-only lock on the open file. */
	setLocked(locked: boolean): void;
};

export type CodePaneHostProps = {
	row: CodeFileRow;
	citationIndex: CitationIndex;
	resolver: () => YDocResolverApi | null;
	labels: CodePaneLabels;
	wrap: boolean;
	onWrapChange: (wrapped: boolean) => void;
	formatOnSave: boolean;
	onFormatOnSaveChange: (enabled: boolean) => void;
	syntaxTheme: SyntaxThemePreference;
	onSyntaxThemeChange: (preference: SyntaxThemePreference) => void;
	diffMode: DiffViewMode;
	onDiffModeChange: (mode: DiffViewMode) => void;
	showDiff: (params: { baseline: string; current: string; mode: DiffViewMode }) => void;
	objectMenuContext: (row: CodeFileRow) => ObjectMenuContext;
	openCitation: CitationOpen;
	onContentChange: (id: string, content: string) => void;
	/** Read-only lock (the open file's synced `locked` property). */
	locked: boolean;
};

function CodePaneHostImpl(
	props: CodePaneHostProps,
	ref: ForwardedRef<CodePaneHostHandle>,
): React.ReactElement {
	const mountRef = useRef<HTMLDivElement>(null);
	const controllerRef = useRef<CodePaneController | null>(null);
	const activeDocRef = useRef<YDocHandle | null>(null);
	const activeRowIdRef = useRef<string | null>(null);
	// Latest props in a ref so the controller (created once) reads current
	// callbacks / labels without re-binding.
	const propsRef = useRef(props);
	propsRef.current = props;

	const acquireDocHandle = (row: CodeFileRow): YDocHandle | null => {
		if (activeRowIdRef.current === row.id && activeDocRef.current) return activeDocRef.current;
		if (activeDocRef.current) {
			activeDocRef.current.release();
			activeDocRef.current = null;
		}
		const api = propsRef.current.resolver();
		if (!api) return null;
		activeDocRef.current = api.resolve(row.id);
		return activeDocRef.current;
	};

	// Mount the controller ONCE; teardown on unmount. The controller reads
	// live props through `propsRef`; row/citation swaps flow through the
	// effect below.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-shot mount.
	useEffect(() => {
		const mount = mountRef.current;
		if (!mount) return;
		const p = propsRef.current;
		const handle = acquireDocHandle(p.row);
		const controller = createCodePane({
			row: p.row,
			citationIndex: p.citationIndex,
			labels: p.labels,
			wrap: p.wrap,
			onWrapChange: (w) => propsRef.current.onWrapChange(w),
			formatOnSave: p.formatOnSave,
			onFormatOnSaveChange: (e) => propsRef.current.onFormatOnSaveChange(e),
			syntaxTheme: p.syntaxTheme,
			onSyntaxThemeChange: (s) => propsRef.current.onSyntaxThemeChange(s),
			diffMode: p.diffMode,
			onDiffModeChange: (m) => propsRef.current.onDiffModeChange(m),
			showDiff: (params) => propsRef.current.showDiff(params),
			objectMenuContext: (current) => propsRef.current.objectMenuContext(current),
			openCitation: (entry) => propsRef.current.openCitation(entry),
			onContentChange: (id, content) => propsRef.current.onContentChange(id, content),
			locked: p.locked,
			...(handle ? { docHandle: handle } : {}),
		});
		controllerRef.current = controller;
		activeRowIdRef.current = p.row.id;
		mount.appendChild(controller.element);
		return () => {
			controller.dispose();
			controllerRef.current = null;
			if (activeDocRef.current) {
				activeDocRef.current.release();
				activeDocRef.current = null;
			}
			activeRowIdRef.current = null;
		};
	}, []);

	// Swap the open file / citation index in place when the row changes.
	// `acquireDocHandle` is a stable render-scope closure reading live refs.
	// biome-ignore lint/correctness/useExhaustiveDependencies: row/citation are the intended triggers.
	useEffect(() => {
		const controller = controllerRef.current;
		if (!controller) return;
		const handle = acquireDocHandle(props.row);
		controller.update({
			row: props.row,
			citationIndex: props.citationIndex,
			...(handle ? { docHandle: handle } : {}),
		});
		activeRowIdRef.current = props.row.id;
	}, [props.row, props.citationIndex]);

	// Apply the read-only lock live when the file's `locked` property changes.
	useEffect(() => {
		controllerRef.current?.setLocked(props.locked);
	}, [props.locked]);

	useImperativeHandle(
		ref,
		() => ({
			focus: () => controllerRef.current?.focus(),
			refresh: () => controllerRef.current?.refresh(),
			setLocked: (l) => controllerRef.current?.setLocked(l),
			menuContext: () => controllerRef.current?.menuContext() ?? null,
			formatBuffer: () => controllerRef.current?.formatBuffer() ?? Promise.resolve(false),
			canFormatBuffer: () => controllerRef.current?.canFormatBuffer() ?? false,
			openFind: (mode) => controllerRef.current?.openFind(mode),
			foldAtCaret: () => controllerRef.current?.foldAtCaret(),
			unfoldAtCaret: () => controllerRef.current?.unfoldAtCaret(),
			unfoldAll: () => controllerRef.current?.unfoldAll(),
			toggleWrap: () => {
				controllerRef.current?.toggleWrap();
			},
			revealLine: (line: number) => {
				const textarea =
					controllerRef.current?.element.querySelector<HTMLTextAreaElement>(".editor__buffer");
				if (!textarea) return;
				const lines = textarea.value.split("\n");
				let offset = 0;
				for (let i = 0; i < line - 1 && i < lines.length; i++) {
					offset += (lines[i]?.length ?? 0) + 1;
				}
				textarea.focus();
				textarea.setSelectionRange(offset, offset);
				const lineHeight = textarea.scrollHeight / Math.max(1, lines.length);
				textarea.scrollTop = Math.max(0, (line - 1) * lineHeight - textarea.clientHeight / 2);
			},
		}),
		[],
	);

	return <div style={{ display: "contents" }} ref={mountRef} />;
}

export const CodePaneHost = forwardRef(CodePaneHostImpl);

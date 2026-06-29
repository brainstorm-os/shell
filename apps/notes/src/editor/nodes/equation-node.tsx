/**
 * EquationNode — LaTeX maths, inline (`$…$`) or block (`$$…$$`). KaTeX is
 * the renderer; it is **lazily** imported (with its stylesheet) the
 * first time an equation paints, so it lands in its own chunk and stays
 * out of the main bundle. Click an equation to edit the raw LaTeX;
 * commit on Enter (Shift+Enter = newline in block mode), Escape cancels,
 * an empty commit deletes the node.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$getNodeByKey,
	DecoratorNode,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { ActionId } from "../../keyboard/action-ids";
import { matchesActionChord } from "../../keyboard/use-shortcut";

export const EQUATION_NODE_TYPE = "equation";
const EQUATION_NODE_VERSION = 1 as const;

export type SerializedEquationNode = SerializedLexicalNode & {
	type: typeof EQUATION_NODE_TYPE;
	version: typeof EQUATION_NODE_VERSION;
	equation: string;
	inline: boolean;
};

type Katex = typeof import("katex")["default"];
let katexLib: Katex | null = null;
let katexLoad: Promise<void> | null = null;

function ensureKatex(): Promise<void> {
	if (katexLib) return Promise.resolve();
	if (!katexLoad) {
		katexLoad = Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([mod]) => {
			katexLib = mod.default;
		});
	}
	return katexLoad;
}

export class EquationNode extends DecoratorNode<JSX.Element> {
	__equation: string;
	__inline: boolean;

	static override getType(): string {
		return EQUATION_NODE_TYPE;
	}

	static override clone(node: EquationNode): EquationNode {
		return new EquationNode(node.__equation, node.__inline, node.__key);
	}

	constructor(equation: string, inline = false, key?: NodeKey) {
		super(key);
		this.__equation = equation;
		this.__inline = inline;
	}

	static override importJSON(s: SerializedEquationNode): EquationNode {
		return new EquationNode(s.equation ?? "", Boolean(s.inline));
	}

	override exportJSON(): SerializedEquationNode {
		return {
			type: EQUATION_NODE_TYPE,
			version: EQUATION_NODE_VERSION,
			equation: this.__equation,
			inline: this.__inline,
		};
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		return document.createElement(this.__inline ? "span" : "div");
	}

	override updateDOM(prev: EquationNode): boolean {
		// Switching inline ⇄ block changes the host element tag.
		return prev.__inline !== this.__inline;
	}

	getEquation(): string {
		return this.__equation;
	}

	setEquation(equation: string): void {
		this.getWritable().__equation = equation;
	}

	override decorate(): JSX.Element {
		return <EquationView nodeKey={this.getKey()} equation={this.__equation} inline={this.__inline} />;
	}

	override isInline(): boolean {
		return this.__inline;
	}
}

function EquationView({
	nodeKey,
	equation,
	inline,
}: {
	nodeKey: NodeKey;
	equation: string;
	inline: boolean;
}) {
	const [editor] = useLexicalComposerContext();
	const [editing, setEditing] = useState(equation.trim().length === 0);
	const [draft, setDraft] = useState(equation);
	const [html, setHtml] = useState<string | null>(null);
	const [error, setError] = useState(false);

	useEffect(() => {
		if (editing) return;
		let cancelled = false;
		ensureKatex()
			.then(() => {
				if (cancelled || !katexLib) return;
				try {
					setHtml(
						katexLib.renderToString(equation, {
							displayMode: !inline,
							throwOnError: false,
							output: "html",
						}),
					);
					setError(false);
				} catch {
					setError(true);
				}
			})
			.catch(() => setError(true));
		return () => {
			cancelled = true;
		};
	}, [equation, inline, editing]);

	const commit = useCallback(() => {
		const next = draft.trim();
		editor.update(() => {
			const node = $getNodeByKey(nodeKey);
			if (!$isEquationNode(node)) return;
			if (next.length === 0) node.remove();
			else node.setEquation(next);
		});
		setEditing(false);
	}, [editor, nodeKey, draft]);

	if (editing) {
		const Tag = inline ? "input" : "textarea";
		return (
			<Tag
				className={
					inline ? "notes__equation-input" : "notes__equation-input notes__equation-input--block"
				}
				value={draft}
				autoFocus
				placeholder={t("notes.equation.placeholder")}
				aria-label={t("notes.equation.placeholder")}
				onChange={(e: { target: { value: string } }) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e: React.KeyboardEvent) => {
					if (matchesActionChord(ActionId.CancelInlineEdit, e)) {
						e.preventDefault();
						setDraft(equation);
						setEditing(false);
						return;
					}
					// keyboard-exempt: input-local commit — Enter (without Shift on a block)
					// commits the LaTeX field the user is editing; cancel already routes
					// through the registry (`ActionId.CancelInlineEdit`) above.
					if (e.key === "Enter" && (inline || !e.shiftKey)) {
						e.preventDefault();
						commit();
					}
				}}
			/>
		);
	}

	const Host = inline ? "span" : "div";
	return (
		<Host
			className={inline ? "notes__equation notes__equation--inline" : "notes__equation"}
			role="button"
			tabIndex={0}
			title={t("notes.equation.edit")}
			onClick={() => {
				setDraft(equation);
				setEditing(true);
			}}
			// keyboard-exempt: standard activation of this `role="button"` — Enter/Space
			// open the equation for editing (the keyboard twin of the click), not an app
			// shortcut.
			onKeyDown={(e: React.KeyboardEvent) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					setDraft(equation);
					setEditing(true);
				}
			}}
		>
			{error ? (
				<span className="notes__equation-error">{equation}</span>
			) : html ? (
				// biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX HTML is generated from the user's own LaTeX with throwOnError:false; KaTeX sanitises its own output.
				<span dangerouslySetInnerHTML={{ __html: html }} />
			) : (
				<span className="notes__equation-raw">{equation}</span>
			)}
		</Host>
	);
}

export function $createEquationNode(equation = "", inline = false): EquationNode {
	return new EquationNode(equation, inline);
}

export function $isEquationNode(node: LexicalNode | null | undefined): node is EquationNode {
	return node instanceof EquationNode;
}

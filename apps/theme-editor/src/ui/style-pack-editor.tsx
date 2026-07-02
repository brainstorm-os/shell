/**
 * StylePack editor pane (9.9.4) — the raw-CSS authoring surface. A name, a
 * monospace CSS editor, a live problem list from the bundle validator
 * (`sanitizeStylePackCss`), and a handoff to open the CSS in the full
 * code-editor app (the cross-app edit loop). Edits report through callbacks
 * (the app owns state + persistence).
 *
 * Rich syntax-highlighted editing lives in the code-editor app (which uses
 * `@brainstorm/sdk/code-highlight`); this pane is the quick inline editor +
 * the validation gate, with "Edit in Code Editor" as the rich-editing path.
 */

import {
	type StylePackDef,
	StylePackSanitizeSeverity,
	sanitizeStylePackCss,
} from "@brainstorm/sdk-types";
import type { ReactElement } from "react";
import type { Translate } from "./translate";

export type StylePackEditorProps = {
	pack: StylePackDef;
	t: Translate;
	/** `false` until the pack is saved (it needs an entity id to open). */
	canOpenInCodeEditor: boolean;
	onName(name: string): void;
	onCss(css: string): void;
	onOpenInCodeEditor(): void;
};

export function StylePackEditor({
	pack,
	t,
	canOpenInCodeEditor,
	onName,
	onCss,
	onOpenInCodeEditor,
}: StylePackEditorProps): ReactElement {
	const issues = sanitizeStylePackCss(pack.css);
	return (
		<div className="te-stylepack">
			<label className="te-field">
				<span className="te-field__label">{t("stylePack.name")}</span>
				<input
					type="text"
					className="bs-input te-stylepack__name"
					value={pack.name}
					aria-label={t("stylePack.name")}
					onChange={(e) => onName(e.target.value)}
				/>
			</label>

			<p className="te-stylepack__hint">{t("stylePack.hint")}</p>

			<label className="te-field te-stylepack__editor-field">
				<span className="te-field__label">{t("stylePack.css")}</span>
				<textarea
					className="bs-input te-stylepack__css"
					value={pack.css}
					spellCheck={false}
					autoCapitalize="off"
					autoComplete="off"
					aria-label={t("stylePack.css")}
					placeholder={t("stylePack.placeholder")}
					onChange={(e) => onCss(e.target.value)}
				/>
			</label>

			<ul className="te-stylepack__problems" role="status">
				{issues.length === 0 ? (
					<li className="te-stylepack__problem te-stylepack__problem--ok">{t("stylePack.clean")}</li>
				) : (
					issues.map((issue, index) => {
						const severe = issue.severity === StylePackSanitizeSeverity.Error;
						return (
							<li
								// biome-ignore lint/suspicious/noArrayIndexKey: issues have no stable id; the list is fully re-derived per render from css.
								key={index}
								className={`te-stylepack__problem te-stylepack__problem--${severe ? "error" : "warning"}`}
							>
								<span className="te-stylepack__problem-loc">
									{t("stylePack.lineLabel", { line: String(issue.line) })}
								</span>{" "}
								{issue.message}
							</li>
						);
					})
				)}
			</ul>

			<div className="te-stylepack__actions">
				<button
					type="button"
					className="bs-btn te-stylepack__open"
					disabled={!canOpenInCodeEditor}
					title={canOpenInCodeEditor ? undefined : t("stylePack.openHintSaveFirst")}
					onClick={onOpenInCodeEditor}
				>
					{t("stylePack.openInCodeEditor")}
				</button>
			</div>
		</div>
	);
}

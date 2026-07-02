/**
 * Typography editor pane (9.9.3) — the font-role mapping UI. A name, one
 * editable font-family stack per `FontRole`, and a density-scale picker.
 * Reports edits through callbacks (the app owns state + live preview +
 * persistence).
 *
 * The scale picker is a fancy-menus anchored menu (the hard menu rule — no
 * native `<select>`). The font-role rows are a roving-tabindex listbox;
 * each row carries a text input, so Arrow keys never fight editing.
 */

import {
	FONT_ROLES,
	type FontRole,
	TYPOGRAPHY_SCALES,
	type TypographyDef,
	type TypographyScale,
} from "@brainstorm/sdk-types";
import { SelectMenu } from "@brainstorm/sdk/select-menu";
import type { ReactElement } from "react";
import type { Translate } from "./translate";

export type TypographyEditorProps = {
	typo: TypographyDef;
	t: Translate;
	onName(name: string): void;
	onFontStack(role: FontRole, stack: string): void;
	onScale(scale: TypographyScale): void;
};

export function TypographyEditor({
	typo,
	t,
	onName,
	onFontStack,
	onScale,
}: TypographyEditorProps): ReactElement {
	return (
		<div className="te-typo">
			<label className="te-field">
				<span className="te-field__label">{t("typo.name")}</span>
				<input
					type="text"
					className="bs-input te-typo__name"
					value={typo.name}
					aria-label={t("typo.name")}
					onChange={(e) => onName(e.target.value)}
				/>
			</label>

			<div className="te-typo__roles" aria-label={t("typo.roles")} role="group">
				{FONT_ROLES.map((role) => (
					<label className="te-field" key={role}>
						<span className="te-field__label">{t(`fontRole.${role}`)}</span>
						<input
							type="text"
							className="bs-input te-typo__stack"
							value={typo.fonts[role]?.stack ?? ""}
							spellCheck={false}
							aria-label={t(`fontRole.${role}`)}
							style={{ fontFamily: `var(--text-family-${role})` }}
							onChange={(e) => onFontStack(role, e.target.value)}
						/>
					</label>
				))}
			</div>

			<div className="te-field">
				<span className="te-field__label">{t("typo.scale")}</span>
				<SelectMenu
					className="te-typo__scale"
					value={typo.scale}
					options={TYPOGRAPHY_SCALES.map((scale) => ({
						value: scale,
						label: t(`scale.${scale}`),
					}))}
					onChange={(next) => onScale(next as TypographyScale)}
					ariaLabel={t("typo.scale")}
				/>
			</div>
		</div>
	);
}

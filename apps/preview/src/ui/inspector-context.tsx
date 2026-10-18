/**
 * The context half of Preview's right panel (9.20.15): what links to the
 * previewed file, and moving it to the Bin. Both sit under the editable
 * property rows; the caption rides those rows as a host-owned `extraRow`.
 *
 * Backlinks come from the shell's `links` rows via the shared
 * `@brainstorm-os/sdk/backlinks` walk — every source type counts (a Note
 * embedding the image, a Task attaching the PDF). A backlink opens in a new
 * tab (Shift → new window), so following one never replaces what the user
 * is previewing.
 */

import { NavigationMode, navModeFromEvent, openEntity } from "@brainstorm-os/sdk";
import type { LinkedEntity } from "@brainstorm-os/sdk/backlinks";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import type { MouseEvent, ReactElement } from "react";
import type { PreviewRuntime } from "../host/runtime";
import { plural, t } from "../i18n";

/** Backlinks always leave the preview in place: a plain click is a new tab,
 *  Shift keeps its new-window meaning. */
export function backlinkNavMode(event: MouseEvent | null): NavigationMode {
	return navModeFromEvent(event) === NavigationMode.NewWindow
		? NavigationMode.NewWindow
		: NavigationMode.NewTab;
}

export function FileBacklinks({
	runtime,
	backlinks,
}: {
	runtime: PreviewRuntime | undefined;
	backlinks: readonly LinkedEntity[];
}): ReactElement {
	return (
		<section className="preview-context" data-testid="preview-backlinks">
			<h3 className="preview-context__heading">
				{backlinks.length > 0
					? plural(backlinks.length, "inspector.linkedFrom.one", "inspector.linkedFrom.other")
					: t("inspector.noBacklinks")}
			</h3>
			{backlinks.length > 0 ? (
				<ul className="preview-context__list">
					{backlinks.map((link) => (
						<li key={link.entityId}>
							<button
								type="button"
								className="preview-context__link"
								data-entity-id={link.entityId}
								aria-label={t("inspector.openInNewTab", { name: link.title })}
								onClick={(event) =>
									void openEntity(runtime, {
										entityId: link.entityId,
										entityType: link.entityType,
										mode: backlinkNavMode(event),
									})
								}
							>
								<span className="preview-context__link-title">{link.title}</span>
								<Icon name={IconName.OpenExternal} size={14} className="preview-context__link-glyph" />
							</button>
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
}

export function MoveToBinButton({
	locked,
	available,
	onMove,
}: {
	locked: boolean;
	/** False when the shell exposes no `entities.delete` — the control then
	 *  does not render at all (there is no path it could ever take). */
	available: boolean;
	onMove: () => void;
}): ReactElement | null {
	if (!available) return null;
	return (
		<div className="preview-context preview-context--actions">
			<button
				type="button"
				className="bs-btn bs-btn--danger preview-context__bin"
				data-testid="preview-move-to-bin"
				disabled={locked}
				{...(locked ? { title: t("inspector.lockedHint") } : {})}
				onClick={() => {
					if (!locked) onMove();
				}}
			>
				<Icon name={IconName.Trash} size={15} />
				{t("inspector.moveToBin")}
			</button>
		</div>
	);
}

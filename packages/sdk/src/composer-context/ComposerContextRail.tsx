/**
 * `<ComposerContextRail>` — the row of chips above a composer showing the
 * context the user has attached to the next turn (pinned documents, mentioned
 * people, media). Each chip is removable. Presentational only: the host owns the
 * draft list (`useComposerContext`) and passes it down.
 */

import type { MessageAttachment } from "@brainstorm-os/sdk-types";
import type { ReactElement } from "react";
import { Icon, IconName } from "../icon";
import { attachmentIcon, attachmentKey, attachmentLabel } from "./types";

export type ComposerContextRailProps = {
	attachments: readonly MessageAttachment[];
	onRemove(ref: string): void;
	/** Accessible label for each chip's remove button — `{label}` interpolates
	 *  the attachment label. Pass a host `t()`-resolved string. */
	removeLabel(label: string): string;
};

export function ComposerContextRail({
	attachments,
	onRemove,
	removeLabel,
}: ComposerContextRailProps): ReactElement | null {
	if (attachments.length === 0) return null;
	return (
		<div className="bs-composer-context" data-testid="composer-context-rail">
			{attachments.map((att) => {
				const label = attachmentLabel(att);
				const key = attachmentKey(att);
				return (
					<span key={key} className="bs-composer-context__chip" data-kind={att.kind}>
						<Icon name={attachmentIcon(att.kind)} size={12} />
						<span className="bs-composer-context__chip-label">{label}</span>
						<button
							type="button"
							className="bs-composer-context__chip-remove"
							aria-label={removeLabel(label)}
							onClick={() => onRemove(key)}
						>
							<Icon name={IconName.Close} size={10} />
						</button>
					</span>
				);
			})}
		</div>
	);
}

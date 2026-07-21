/**
 * Nothing-selected detail pane — the shared `<EmptyState>` (per
 * [[extract-to-sdk-at-copy-two]]: no bespoke placeholder chrome) with a
 * "New contact" CTA wired to the same compose popover as the header + list
 * empties, so the empty pane is actionable like Chat / Mailbox / Books. The
 * hint adapts when the contact list panel is hidden — "choose from the list"
 * is a dead instruction with no list on screen.
 *
 * Icon: `AddressBook` — the shared set's people/contacts glyph — so the empty
 * state reads as topical (like Mailbox's envelope, Chat's speech bubble)
 * instead of the generic `Entity` cube fallback.
 */

import { EmptyState } from "@brainstorm-os/sdk/empty-state";
import { IconName } from "@brainstorm-os/sdk/icon";
import type { ReactElement } from "react";
import { t } from "../i18n";

export function NoSelection({
	listOpen,
	onCreate,
}: {
	listOpen: boolean;
	onCreate: () => void;
}): ReactElement {
	return (
		<EmptyState
			icon={IconName.AddressBook}
			title={t("placeholder.title")}
			hint={t(listOpen ? "placeholder.blurb" : "placeholder.blurb.listHidden")}
			action={
				<button
					type="button"
					className="bs-btn"
					data-bs-primary=""
					data-testid="contacts-placeholder-new"
					onClick={onCreate}
				>
					{t("list.new")}
				</button>
			}
		/>
	);
}

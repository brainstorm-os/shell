/**
 * Welcome → "Migrating from…" entry (IE-3, doc 45 §Discoverability).
 *
 * Sits next to the Create / Open / Join CTAs on the first-launch screen. Opens a
 * `<Popover>` that names the supported switch-in sources (Obsidian, Notion
 * export, generic files) and routes the user into vault creation — once the new
 * vault is open the dashboard auto-opens Settings → Backup & Migration (the
 * one-shot in `migration-intent.ts`). The actual import lives in that panel; this
 * is purely the discoverable entry the first-run user lands on.
 */

import { AnimatePresence } from "framer-motion";
import { useState } from "react";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { IconName } from "../ui/icon";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { WelcomeTile } from "./welcome-tile";

export type MigrateEntryProps = {
	disabled?: boolean;
	/** Begin the migrate flow: record the intent and route to vault creation. */
	onStart: () => void;
};

export function MigrateEntry({ disabled = false, onStart }: MigrateEntryProps) {
	const [open, setOpen] = useState(false);
	const sources: ReadonlyArray<{ key: string; label: string }> = [
		{ key: "obsidian", label: t("shell.welcome.migrate.obsidian") },
		{ key: "notion", label: t("shell.welcome.migrate.notion") },
		{ key: "files", label: t("shell.welcome.migrate.files") },
	];
	return (
		<>
			<WelcomeTile
				icon={IconName.Download}
				label={t("shell.welcome.migrate.cta")}
				onClick={() => setOpen(true)}
				disabled={disabled}
				testId="welcome-migrate"
			/>
			<AnimatePresence>
				{open && (
					<Popover
						title={t("shell.welcome.migrate.title")}
						size={PopoverSize.Small}
						bodyPadding={PopoverBodyPadding.Comfortable}
						onClose={() => setOpen(false)}
						testId="welcome-migrate-popover"
					>
						<div className="welcome__migrate">
							<p className="welcome__migrate-subtitle">{t("shell.welcome.migrate.subtitle")}</p>
							<ul className="welcome__migrate-sources">
								{sources.map((source) => (
									<li key={source.key} className="welcome__migrate-source">
										{source.label}
									</li>
								))}
							</ul>
							<p className="welcome__hint">{t("shell.welcome.migrate.hint")}</p>
							<Button
								variant={ButtonVariant.Primary}
								size={ButtonSize.Lg}
								iconLeft={IconName.Plus}
								onClick={() => {
									setOpen(false);
									onStart();
								}}
								data-testid="welcome-migrate-start"
							>
								{t("shell.welcome.migrate.start")}
							</Button>
						</div>
					</Popover>
				)}
			</AnimatePresence>
		</>
	);
}

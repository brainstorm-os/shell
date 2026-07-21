/**
 * Smart-folders sidebar list (9.8.9): the saved searches, each a one-click
 * re-run of its query + scope. The row ⋯ opens a rename / delete menu
 * through the shared fancy-menus runtime (never bespoke chrome). Renaming
 * routes through the same `<SmartFolderNamePopover>` the save flow uses.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { MenuAlign } from "@brainstorm-os/sdk/menus";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { t } from "../i18n";
import { SearchScope } from "../logic/search";
import type { SmartFolder } from "../logic/smart-folders";

function scopeLabel(scope: SearchScope): string {
	if (scope === SearchScope.Subfolders) return t("brainstorm.files.smart.scopeSubfolders");
	if (scope === SearchScope.Vault) return t("brainstorm.files.smart.scopeVault");
	return t("brainstorm.files.smart.scopeActive");
}

export type SmartFolderListProps = {
	folders: readonly SmartFolder[];
	onActivate: (folder: SmartFolder) => void;
	onRename: (folder: SmartFolder) => void;
	onDelete: (id: string) => void;
};

export function SmartFolderList({ folders, onActivate, onRename, onDelete }: SmartFolderListProps) {
	if (folders.length === 0) return null;
	return (
		<ul className="sidebar__list smart-folders" data-testid="smart-folders">
			{folders.map((folder) => (
				<li key={folder.id} className="smart-folders__row">
					<button
						type="button"
						className="smart-folders__open"
						data-testid="smart-folder-open"
						title={`${folder.query} ${scopeLabel(folder.scope)}`}
						aria-label={t("brainstorm.files.smart.activate", { name: folder.name })}
						onClick={() => onActivate(folder)}
					>
						<Icon name={IconName.Search} size={15} className="smart-folders__glyph" />
						<span className="smart-folders__name">{folder.name}</span>
					</button>
					<button
						type="button"
						className="smart-folders__more"
						data-testid="smart-folder-more"
						aria-label={t("brainstorm.files.smart.more")}
						aria-haspopup="menu"
						onClick={(e) => {
							const trigger = e.currentTarget;
							const rect = trigger.getBoundingClientRect();
							const items: AnchoredMenuItem[] = [
								{
									label: t("brainstorm.files.smart.rename"),
									icon: IconName.Pencil,
									onSelect: () => onRename(folder),
								},
								{
									label: t("brainstorm.files.smart.delete"),
									icon: IconName.Trash,
									destructive: true,
									onSelect: () => onDelete(folder.id),
								},
							];
							openAnchoredMenu({ x: rect.right, y: rect.bottom + 4 }, items, {
								menuLabel: t("brainstorm.files.smart.more"),
								anchor: trigger,
								align: MenuAlign.End,
							});
						}}
					>
						⋯
					</button>
				</li>
			))}
		</ul>
	);
}

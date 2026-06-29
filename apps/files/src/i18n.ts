/**
 * App-side translations per
 * §Localization and.
 *
 * `t` is produced by the shared `@brainstorm/sdk/i18n` `createT` (the B-2
 * app-side `t()`): call sites depend on the **id**, the default-English
 * manifest fills in until the locale layer (Stage 12) lands, and a
 * future localised build passes a `Partial<MANIFEST>` of overrides. The
 * `brainstorm.files.*` id namespace mirrors what
 * manager-ux.md §Localization enumerates.
 */

import { createT } from "@brainstorm/sdk/i18n";

const DEFAULTS = {
	// App chrome
	"brainstorm.files.app.title": "Files",
	"brainstorm.files.app.runtimeMissing":
		"Preload missing — window.brainstorm not stamped. Check the main-process console.",

	// Toolbar actions
	"brainstorm.files.actions.new": "New",
	"brainstorm.files.actions.newFolder": "New folder",
	"brainstorm.files.actions.newFile": "New file",
	"brainstorm.files.upload.dialogTitle": "Choose files to upload",
	"brainstorm.files.upload.filterAny": "All files",
	"brainstorm.files.upload.unavailable":
		"File upload is unavailable — the files service is not exposed in this build.",
	"brainstorm.files.upload.readFailed": "Could not read “{name}”.",
	"brainstorm.files.actions.search": "Search",
	"brainstorm.files.actions.sidebar": "Sidebar",
	"brainstorm.files.actions.showSidebar": "Show sidebar",
	"brainstorm.files.actions.hideSidebar": "Hide sidebar",
	"brainstorm.files.actions.inspector": "Inspector",
	"brainstorm.files.actions.showInspector": "Show inspector",
	"brainstorm.files.actions.hideInspector": "Hide inspector",
	"brainstorm.files.actions.open": "Open",
	"brainstorm.files.actions.rename": "Rename",
	"brainstorm.files.actions.delete": "Delete",
	"brainstorm.files.actions.duplicate": "Duplicate",
	"brainstorm.files.actions.quickLook": "Quick Look",
	"brainstorm.files.actions.back": "Back",
	"brainstorm.files.actions.forward": "Forward",
	"brainstorm.files.actions.closeInspector": "Close inspector",
	"brainstorm.files.actions.resizeSidebar": "Resize sidebar",
	"brainstorm.files.actions.resizeInspector": "Resize inspector",
	"brainstorm.files.rename.inputLabel": "Renaming {name} — type a new name, press Enter to commit",

	// Breadcrumb
	"brainstorm.files.breadcrumb.label": "Folder path",
	"brainstorm.files.breadcrumb.vaultRoot": "Vault",
	"brainstorm.files.breadcrumb.collapsed": "Hidden folders",

	// Sidebar
	"brainstorm.files.sidebar.label": "Locations",
	"brainstorm.files.sidebar.pinned": "Pinned",
	"brainstorm.files.sidebar.folders": "Folders",
	"brainstorm.files.sidebar.smartFolders": "Smart folders",
	"brainstorm.files.sidebar.tags": "Tags",
	"brainstorm.files.sidebar.toggleSection": "Collapse {label}",
	"brainstorm.files.sidebar.smartFoldersSoon": "Saved searches arrive with smart folders",
	"brainstorm.files.sidebar.tagsSoon": "Tags arrive with property schemas",
	"brainstorm.files.sidebar.comingSoon": "Coming soon",

	// Content / status
	"brainstorm.files.content.label": "Folder contents",
	"brainstorm.files.status.itemsZero": "Empty folder",
	"brainstorm.files.status.itemsCount.one": "{count} item",
	"brainstorm.files.status.itemsCount.other": "{count} items",

	// Entity kind labels (shown when an entity carries no MIME type)
	"brainstorm.files.type.file": "File",
	"brainstorm.files.type.note": "Note",
	"brainstorm.files.search.placeholderFolder": "Search this folder",
	"brainstorm.files.search.scope.active": "This folder",
	"brainstorm.files.search.scope.subfolders": "Subfolders",
	"brainstorm.files.search.scope.vault": "Vault",

	// Smart folders (saved searches)
	"brainstorm.files.smart.save": "Save search",
	"brainstorm.files.smart.saveTitle": "Save as smart folder",
	"brainstorm.files.smart.namePlaceholder": "Name this search",
	"brainstorm.files.smart.saveAction": "Save",
	"brainstorm.files.smart.cancel": "Cancel",
	"brainstorm.files.smart.activate": "Open saved search {name}",
	"brainstorm.files.smart.more": "Smart folder actions",
	"brainstorm.files.smart.rename": "Rename",
	"brainstorm.files.smart.delete": "Delete",
	"brainstorm.files.smart.renameTitle": "Rename smart folder",
	"brainstorm.files.smart.scopeActive": "in this folder",
	"brainstorm.files.smart.scopeSubfolders": "in subfolders",
	"brainstorm.files.smart.scopeVault": "across the vault",

	// View modes
	"brainstorm.files.view.list": "List",
	"brainstorm.files.view.grid": "Grid",
	"brainstorm.files.view.gallery": "Gallery",
	"brainstorm.files.view.iconList": "Icons",
	"brainstorm.files.view.column": "Column",
	"brainstorm.files.view.label": "View mode",
	"brainstorm.files.storage.open": "Storage",
	"brainstorm.files.storage.allMedia": "All media",
	"brainstorm.files.sidebar.storage": "Storage",
	"brainstorm.files.storage.title": "Storage",
	"brainstorm.files.storage.loading": "Measuring storage…",
	"brainstorm.files.storage.count.one": "{count} item",
	"brainstorm.files.storage.count.other": "{count} items",
	"brainstorm.files.storage.empty": "Nothing is using vault storage yet.",
	"brainstorm.files.storage.openInPreview": "Open in Preview",
	"brainstorm.files.storage.kind.upload": "File",
	"brainstorm.files.storage.kind.cover": "Cover",
	"brainstorm.files.storage.kind.wallpaper": "Wallpaper",
	"brainstorm.files.storage.kind.icon": "Icon",
	"brainstorm.files.storage.kind.favicon": "Favicon",

	// Sort
	"brainstorm.files.sort.label": "Sort by",
	"brainstorm.files.sort.menu": "Sort by",
	"brainstorm.files.sort.manual": "Manual",
	"brainstorm.files.sort.name": "Name",
	"brainstorm.files.sort.created": "Date created",
	"brainstorm.files.sort.modified": "Date modified",
	"brainstorm.files.sort.size": "Size",
	"brainstorm.files.sort.directionAsc": "Ascending",
	"brainstorm.files.sort.directionDesc": "Descending",

	// Group-by + per-folder view options (9.8.11)
	"brainstorm.files.group.label": "Group by",
	"brainstorm.files.group.none": "None",
	"brainstorm.files.group.type": "Type",
	"brainstorm.files.group.letter": "First letter",
	"brainstorm.files.group.month": "Date modified",
	"brainstorm.files.group.folders": "Folders",
	"brainstorm.files.group.noExtension": "No extension",
	"brainstorm.files.group.otherLetter": "#",
	"brainstorm.files.view.applyToAll": "Apply to all folders",
	"brainstorm.files.tileSize.label": "Tile size",
	"brainstorm.files.tileSize.small": "Small",
	"brainstorm.files.tileSize.medium": "Medium",
	"brainstorm.files.tileSize.large": "Large",
	"brainstorm.files.columns.label": "Columns",
	"brainstorm.files.columns.kind": "Kind",
	"brainstorm.files.columns.modified": "Date modified",
	"brainstorm.files.columns.size": "Size",

	// Bulk-action bar (9.8.12)
	"brainstorm.files.bulk.region": "Selection actions",
	"brainstorm.files.bulk.count.one": "{count} selected",
	"brainstorm.files.bulk.count.other": "{count} selected",
	"brainstorm.files.bulk.duplicate": "Duplicate",
	"brainstorm.files.bulk.delete": "Delete",
	"brainstorm.files.bulk.clear": "Clear selection",
	"brainstorm.files.bulk.move": "Move to…",
	"brainstorm.files.bulk.copy": "Copy to…",
	"brainstorm.files.bulk.rename": "Rename…",
	"brainstorm.files.bulk.moveTitle": "Move to folder",
	"brainstorm.files.bulk.copyTitle": "Copy to folder",
	"brainstorm.files.bulk.noDestinations": "No other folders to choose.",
	"brainstorm.files.bulk.searchDestinations": "Search folders…",
	"brainstorm.files.bulk.renameTitle": "Rename {n} items",
	"brainstorm.files.bulk.renamePlaceholder": "Base name…",
	"brainstorm.files.bulk.renamePreview": "Items become \u201c{example}\u201d, numbered in order.",
	"brainstorm.files.bulk.renameApply": "Rename",

	// Content list (a11y)
	"brainstorm.files.contentList.label": "Folder contents",
	"brainstorm.files.row.dragToApp": "Drag to another app",
	"brainstorm.files.row.exportOut": "Drag out to your computer",

	// Empty state
	"brainstorm.files.empty.title": "This folder is empty",
	"brainstorm.files.empty.body": "Drag files in, or create a folder to get started.",
	"brainstorm.files.empty.newFolder": "New folder",
	"brainstorm.files.empty.searchTitle": "No matches",
	"brainstorm.files.empty.searchBody": "No entities in this scope match {query}.",

	// Inspector
	"brainstorm.files.inspector.tabsRegion": "Inspector tabs",
	"brainstorm.files.inspector.tabPreview": "Preview",
	"brainstorm.files.inspector.tabProperties": "Properties",
	"brainstorm.files.inspector.tabLinks": "Links",
	"brainstorm.files.inspector.tabComments": "Comments",
	"brainstorm.files.inspector.commentsUnavailable": "Comments aren't available here.",
	"brainstorm.files.inspector.emptySelection": "Select an item to inspect.",
	"brainstorm.files.inspector.noLinks": "No links to or from this entity.",
	"brainstorm.files.inspector.linksOutgoing": "Links to",
	"brainstorm.files.inspector.linksIncoming": "Linked from",
	"brainstorm.files.inspector.openEntity": "Open “{name}”",
	"brainstorm.files.inspector.untitledEntity": "(untitled)",
	"brainstorm.files.inspector.unknownEntity": "(unknown entity)",
	"brainstorm.files.inspector.propertyName": "Name",
	"brainstorm.files.inspector.propertyDescription": "Description",
	"brainstorm.files.inspector.propertyType": "Type",
	"brainstorm.files.inspector.propertySize": "Size",
	"brainstorm.files.inspector.propertyMime": "MIME",
	"brainstorm.files.inspector.propertyMembers": "Items",
	"brainstorm.files.inspector.propertyCreated": "Created",
	"brainstorm.files.inspector.propertyModified": "Modified",

	// Confirm / collision dialogs
	"brainstorm.files.collision.title": "Name already in use",
	"brainstorm.files.collision.body":
		"A folder or file named “{name}” already exists in “{folder}”. What would you like to do?",
	"brainstorm.files.collision.renameAnyway": "Rename anyway",
	"brainstorm.files.collision.cancel": "Cancel",
	"brainstorm.files.delete.title": "Move to Recently Deleted?",
	"brainstorm.files.delete.bodyOne":
		"“{name}” will move to Recently Deleted. You can restore it within 30 days.",
	"brainstorm.files.delete.bodyN":
		"{count} items will move to Recently Deleted. You can restore them within 30 days.",
	"brainstorm.files.delete.confirm": "Move to Recently Deleted",
	"brainstorm.files.delete.cancel": "Cancel",
	"brainstorm.files.cycle.title": "Cannot move into a subfolder",
	"brainstorm.files.cycle.body":
		"“{name}” contains “{dest}”, so moving it inside “{dest}” would create a cycle.",
	"brainstorm.files.cycle.ok": "OK",

	// Object menu (shared chrome labels — passed to ObjectMenuTrigger)
	"brainstorm.files.menu.open": "Open",
	"brainstorm.files.menu.openWith": "Open with",
	"brainstorm.files.menu.pin": "Pin to dashboard",
	"brainstorm.files.menu.unpin": "Remove from dashboard",
	"brainstorm.files.menu.remove": "Delete",
	"brainstorm.files.menu.more": "More actions",
	"brainstorm.files.menu.duplicate": "Duplicate",
	"brainstorm.files.menu.rename": "Rename",

	// Folder appearance pickers
	"brainstorm.files.appearance.editIcon": "Change icon",
	"brainstorm.files.appearance.editCover": "Change cover",

	// Toasts
	"brainstorm.files.toast.openFallback": "No app registered for {type} — preview only.",
} as const;

export type FilesManifest = typeof DEFAULTS;
export type TranslationKey = keyof FilesManifest;

/** The app-side translate function (shared B-2 `createT`). A localised
 *  build calls `createT(DEFAULTS, overrides)`; v1 ships English only. */
export const t = createT(DEFAULTS);

/** Test helper for assertions over the default manifest. Not exported via a
 *  public surface; tests import directly. */
export function _defaultsForTesting(): Readonly<FilesManifest> {
	return DEFAULTS;
}

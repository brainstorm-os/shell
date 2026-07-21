/**
 * `@brainstorm-os/sdk/object-menu` — the cross-app object context menu. The
 * headless builder (`buildObjectMenuItems`) decides *what* actions exist;
 * the renderer (`openObjectMenu` / `<ObjectMenuTrigger>`) decides *how*
 * they look — one shared glass popup so every app's menu is identical.
 * Apps wire it with `attachObjectMenuTrigger` (right-click + ⋯ button).
 */

export {
	DEFAULT_OBJECT_MENU_LABELS,
	buildObjectMenuItems,
	isObjectPinned,
	type BuildObjectMenuOptions,
	type ObjectMenuExtraItem,
	type ObjectMenuItem,
	type ObjectMenuLabels,
	type ObjectMenuRuntime,
	type ObjectMenuTarget,
} from "./object-menu";
export {
	DEFAULT_OBJECT_MENU_CHROME_LABELS,
	resolveObjectMenuChromeLabels,
	type ObjectMenuChromeLabels,
} from "./menu-labels";
export {
	closeAnchoredMenu,
	openAnchoredMenu,
	type AnchoredMenuItem,
	type OpenAnchoredMenuOptions,
} from "./anchored-menu";
export {
	closeObjectMenu,
	openObjectMenu,
	type ObjectMenuCollections,
	type OpenObjectMenuOptions,
} from "./open-object-menu";
export {
	COLLECTIONS_WRITE_CAPABILITY,
	listCollectionsForObject,
	toggleCollectionMembership,
	type CollectionOption,
	type CollectionsEntitiesService,
} from "./collections";
export {
	attachObjectMenuTrigger,
	type AttachObjectMenuTriggerOptions,
	type ObjectMenuContext,
	type ObjectMenuTriggerHandle,
} from "./object-menu-trigger";
export {
	ObjectMenuMoreButton,
	ObjectMenuTrigger,
	type ObjectMenuMoreButtonProps,
	type ObjectMenuTriggerProps,
} from "./object-menu-react";
export {
	ENTITY_ID_ATTR,
	ENTITY_TYPE_ATTR,
	bindDelegatedObjectMenu,
	createMoreButton,
	type CreateMoreButtonOptions,
	type DelegatedMenuResolver,
	type DelegatedMenuTarget,
} from "./delegated";
export { paintHeaderRight } from "./header-right";

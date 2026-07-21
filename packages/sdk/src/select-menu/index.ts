/**
 * `@brainstorm-os/sdk/select-menu` — the one select control. A `.bs-select`
 * trigger (React `<SelectMenu>` or DOM `createSelectMenu`) opening its
 * option list through the shared fancy-menus runtime — the replacement for
 * every native `<select>` so dropdowns share the menu chrome, keyboard
 * model, theming, and a11y.
 */

export {
	type OpenSelectMenuParams,
	openSelectMenu,
	type SelectMenuOption,
} from "./open-select-menu";
export { SelectMenu, type SelectMenuProps } from "./select-menu";
export {
	type CreateSelectMenuParams,
	createSelectMenu,
	type SelectMenuHandle,
} from "./create-select-menu";
export {
	type MultiSelectMenuOption,
	type OpenMultiSelectMenuParams,
	openMultiSelectMenu,
} from "./open-multi-select-menu";
export { MultiSelectMenu, type MultiSelectMenuProps } from "./multi-select-menu";

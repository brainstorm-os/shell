/**
 * `@brainstorm-os/sdk/color-picker` — the shared rich colour picker: a 2D
 * saturation×value area + hue track + hex field, mounted as a fancy-menus
 * custom-body surface and opened imperatively, anchored to a swatch. The
 * themed replacement for the OS `<input type="color">`.
 *
 * Pair the JS with the stylesheet:
 *   import { openColorPicker } from "@brainstorm-os/sdk/color-picker";
 *   import "@brainstorm-os/sdk/color-picker.css";
 */

export type { ColorPickerLabels } from "./color-picker-body";
export { openColorPicker, type OpenColorPickerOptions } from "./open-color-picker";
export { type Hsv, hexToHsv, hsvToHex, normalizeHex } from "./color-conversion";

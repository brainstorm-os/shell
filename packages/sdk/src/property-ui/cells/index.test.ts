import { PropertyView, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { CheckboxCell } from "./checkbox-cell";
import { DateCell, RelativeDateCell } from "./date-cell";
import { FileListCell, GalleryCell, ImageRowCell } from "./file-cell";
import { FormattedPillCell, FormattedPlainCell } from "./formatted-cell";
import { cellRegistryKey, getCell, hasCell, registeredCellKeys } from "./index";
import { LinkCardCell, LinkInlineCell } from "./link-cell";
import { MultilineCell } from "./multiline-cell";
import { PillCell } from "./pill-cell";
import { PlainCell } from "./plain-cell";
import { ProgressBarCell } from "./progress-cell";
import { RatingCell } from "./rating-cell";
import { TagCell } from "./tag-cell";
import { ToggleCell } from "./toggle-cell";

describe("cell registry", () => {
	it("cellRegistryKey produces the canonical `${valueType}::${view}` string", () => {
		expect(cellRegistryKey(ValueType.Text, PropertyView.Pill)).toBe("text::pill");
		expect(cellRegistryKey(ValueType.Boolean, PropertyView.Checkbox)).toBe("boolean::checkbox");
	});

	it("routes Pill/Plain per value type (B5.9 specialised cells)", () => {
		// Text → formatted cell (plain text + url/email/phone validation).
		expect(getCell(ValueType.Text, PropertyView.Pill)).toBe(FormattedPillCell);
		expect(getCell(ValueType.Text, PropertyView.Plain)).toBe(FormattedPlainCell);
		// Date → the natural-language date popover.
		expect(getCell(ValueType.Date, PropertyView.Pill)).toBe(DateCell);
		expect(getCell(ValueType.Date, PropertyView.Plain)).toBe(DateCell);
		// Number / EntityRef keep the generic pill/plain.
		expect(getCell(ValueType.Number, PropertyView.Pill)).toBe(PillCell);
		expect(getCell(ValueType.Number, PropertyView.Plain)).toBe(PlainCell);
		expect(getCell(ValueType.EntityRef, PropertyView.Pill)).toBe(PillCell);
		expect(getCell(ValueType.EntityRef, PropertyView.Plain)).toBe(PlainCell);
	});

	it("returns CheckboxCell for Boolean::Checkbox", () => {
		expect(getCell(ValueType.Boolean, PropertyView.Checkbox)).toBe(CheckboxCell);
	});

	it("returns TagCell for Text::Tag and Text::TagList (B5.7)", () => {
		expect(getCell(ValueType.Text, PropertyView.Tag)).toBe(TagCell);
		expect(getCell(ValueType.Text, PropertyView.TagList)).toBe(TagCell);
	});

	it("returns the B5.9 cells for Progress / File / Link views", () => {
		expect(getCell(ValueType.Number, PropertyView.ProgressBar)).toBe(ProgressBarCell);
		expect(getCell(ValueType.EntityRef, PropertyView.FileList)).toBe(FileListCell);
		expect(getCell(ValueType.EntityRef, PropertyView.Gallery)).toBe(GalleryCell);
		expect(getCell(ValueType.EntityRef, PropertyView.ImageRow)).toBe(ImageRowCell);
		expect(getCell(ValueType.EntityRef, PropertyView.LinkInline)).toBe(LinkInlineCell);
		expect(getCell(ValueType.EntityRef, PropertyView.LinkCard)).toBe(LinkCardCell);
	});

	it("ships the editing cells for the formerly-unshipped views", () => {
		// Multiline / Toggle / Rating / Relative / Calendar / Chip / Card now
		// resolve to a real editing cell.
		expect(getCell(ValueType.Text, PropertyView.Multiline)).toBe(MultilineCell);
		expect(getCell(ValueType.Number, PropertyView.Rating)).toBe(RatingCell);
		expect(getCell(ValueType.Boolean, PropertyView.Toggle)).toBe(ToggleCell);
		expect(getCell(ValueType.Date, PropertyView.Calendar)).toBe(DateCell);
		expect(getCell(ValueType.Date, PropertyView.Relative)).toBe(RelativeDateCell);
		expect(getCell(ValueType.EntityRef, PropertyView.Chip)).toBe(LinkInlineCell);
		expect(getCell(ValueType.EntityRef, PropertyView.Card)).toBe(LinkCardCell);
	});

	it("returns undefined for still-unshipped (valueType, view) pairs", () => {
		// RichText Block / Inline + the file Viewer / Thumbnail views have no
		// cell yet.
		expect(getCell(ValueType.RichText, PropertyView.Block)).toBeUndefined();
		expect(getCell(ValueType.EntityRef, PropertyView.Viewer)).toBeUndefined();
	});

	it("hasCell mirrors getCell's presence check", () => {
		expect(hasCell(ValueType.Text, PropertyView.Pill)).toBe(true);
		expect(hasCell(ValueType.EntityRef, PropertyView.Gallery)).toBe(true);
		expect(hasCell(ValueType.Boolean, PropertyView.Toggle)).toBe(true);
		expect(hasCell(ValueType.RichText, PropertyView.Block)).toBe(false);
	});

	it("ships exactly the expected 25 registry entries", () => {
		// 8 Pill/Plain (Text/Number/Date/EntityRef ×2) + 1 Text::Multiline
		// + 1 Boolean::Checkbox + 1 Boolean::Toggle + 2 Tag + 1 ProgressBar
		// + 1 Rating + 2 extra Date (Calendar + Relative) + 3 File-aware
		// + 2 Link + 2 EntityRef Chip/Card + 1 Number::Formula = 25.
		expect(registeredCellKeys().length).toBe(25);
	});

	it("never registers a (valueType, view) pair the spec does not allow", () => {
		// Sanity: Boolean shouldn't accidentally route to Pill.
		expect(getCell(ValueType.Boolean, PropertyView.Pill)).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import {
	BREADCRUMB_ELLIPSIS_ID,
	type ChromeAction,
	ChromeActionId,
	ChromeAlignment,
	type ChromeCrumb,
	type ChromeMetaField,
	actionBarOptions,
	breadcrumbOptions,
	collapseCrumbs,
	entityHeaderOptions,
	metaOptions,
	selectActions,
	selectMetaFields,
	windowControlsOptions,
} from "./contract";

const action = (id: string): ChromeAction => ({ id, label: id, onSelect: () => {} });
const crumb = (id: string): ChromeCrumb => ({ id, label: id });
const meta = (id: string): ChromeMetaField => ({ id, label: id, value: id });

describe("option readers tolerate a hand-edited layout", () => {
	it("actionBar defaults to end-aligned with every host action", () => {
		expect(actionBarOptions(undefined)).toEqual({ alignment: ChromeAlignment.End });
	});

	it("actionBar reads alignment + buttons", () => {
		expect(actionBarOptions({ alignment: "start", buttons: ["open", "share"] })).toEqual({
			alignment: ChromeAlignment.Start,
			buttons: ["open", "share"],
		});
	});

	it("an unknown alignment falls back rather than reaching the DOM", () => {
		expect(actionBarOptions({ alignment: "sideways" }).alignment).toBe(ChromeAlignment.End);
	});

	it("a non-array buttons value is ignored, not spread", () => {
		expect(actionBarOptions({ buttons: "open" }).buttons).toBeUndefined();
	});

	it("non-string entries in buttons are dropped", () => {
		expect(actionBarOptions({ buttons: ["open", 7, null, "share"] }).buttons).toEqual([
			"open",
			"share",
		]);
	});

	it("meta with no fields option means all fields", () => {
		expect(metaOptions({})).toEqual({});
		expect(metaOptions({ fields: ["createdAt"] })).toEqual({ fields: ["createdAt"] });
	});

	it("entityHeader shows icon + actions by default", () => {
		expect(entityHeaderOptions(undefined)).toEqual({
			showIcon: true,
			showActions: true,
			alignment: ChromeAlignment.Start,
		});
		expect(entityHeaderOptions({ showIcon: false }).showIcon).toBe(false);
	});

	it("a non-boolean toggle falls back to the default", () => {
		expect(entityHeaderOptions({ showActions: "no" }).showActions).toBe(true);
	});

	it("breadcrumb maxItems floors, and rejects zero / negative / NaN", () => {
		expect(breadcrumbOptions({ maxItems: 4.7 }).maxItems).toBe(4);
		expect(breadcrumbOptions({ maxItems: 0 }).maxItems).toBe(0);
		expect(breadcrumbOptions({ maxItems: -3 }).maxItems).toBe(0);
		expect(breadcrumbOptions({ maxItems: Number.NaN }).maxItems).toBe(0);
		expect(breadcrumbOptions(undefined).maxItems).toBe(0);
	});

	it("windowControls defaults to end-aligned", () => {
		expect(windowControlsOptions(undefined)).toEqual({ alignment: ChromeAlignment.End });
	});
});

describe("selectActions", () => {
	const actions = [action(ChromeActionId.Open), action(ChromeActionId.Share), action("io.app/x")];

	it("no buttons option ⇒ every host action, host order", () => {
		expect(selectActions(actions, undefined)).toEqual(actions);
	});

	it("narrows AND reorders to the layout's list", () => {
		expect(selectActions(actions, ["io.app/x", "open"]).map((a) => a.id)).toEqual([
			"io.app/x",
			"open",
		]);
	});

	it("drops a button the host does not offer, rather than rendering a dead one", () => {
		expect(selectActions(actions, ["open", "nope"]).map((a) => a.id)).toEqual(["open"]);
	});

	it("an empty result is empty, not a fallback to everything", () => {
		expect(selectActions(actions, ["nope"])).toEqual([]);
	});
});

describe("selectMetaFields", () => {
	const fields = [meta("createdAt"), meta("modifiedAt"), meta("author")];

	it("narrows and orders", () => {
		expect(selectMetaFields(fields, ["author", "createdAt"]).map((f) => f.id)).toEqual([
			"author",
			"createdAt",
		]);
	});

	it("passes everything through with no option", () => {
		expect(selectMetaFields(fields, undefined)).toEqual(fields);
	});
});

describe("collapseCrumbs", () => {
	const trail = ["a", "b", "c", "d", "e"].map(crumb);

	it("keeps the first and the last two, ellipsing the middle", () => {
		expect(collapseCrumbs(trail, 4).map((c) => c.id)).toEqual([
			"a",
			BREADCRUMB_ELLIPSIS_ID,
			"d",
			"e",
		]);
	});

	it("is a no-op when the trail already fits", () => {
		expect(collapseCrumbs(trail, 5)).toEqual(trail);
		expect(collapseCrumbs(trail, 9)).toEqual(trail);
	});

	it("is a no-op with no limit", () => {
		expect(collapseCrumbs(trail, 0)).toEqual(trail);
	});

	it("never collapses a trail of three or fewer (nothing to hide)", () => {
		const short = ["a", "b", "c"].map(crumb);
		expect(collapseCrumbs(short, 1)).toEqual(short);
	});
});

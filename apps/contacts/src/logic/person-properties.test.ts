import { DateGranularity } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import type { Person } from "../types/person";
import {
	PERSON_PROP_KEY,
	applyPersonPropertyValue,
	personToValues,
	splitMultiValue,
} from "./person-properties";

function makePerson(over: Partial<Person> = {}): Person {
	return {
		id: "p1",
		name: "Ada",
		emails: ["a@x.com", "a2@x.com"],
		phones: ["+1 555"],
		companyId: "co_1",
		role: "Founder",
		birthday: 1_000,
		anniversary: null,
		linkIds: [],
		bio: "hi",
		...over,
	};
}

describe("personToValues", () => {
	it("joins multi-value email / phone with newlines", () => {
		const values = personToValues(makePerson());
		expect(values[PERSON_PROP_KEY.email]).toBe("a@x.com\na2@x.com");
		expect(values[PERSON_PROP_KEY.phone]).toBe("+1 555");
	});
	it("emits a DateValue for the birthday", () => {
		const values = personToValues(makePerson({ birthday: 42 }));
		expect(values[PERSON_PROP_KEY.birthday]).toEqual({
			at: 42,
			granularity: DateGranularity.Date,
		});
	});
	it("omits the birthday when unset", () => {
		const values = personToValues(makePerson({ birthday: null }));
		expect(PERSON_PROP_KEY.birthday in values).toBe(false);
	});
	it("emits a DateValue for the anniversary, omitted when unset", () => {
		const values = personToValues(makePerson({ anniversary: 77 }));
		expect(values[PERSON_PROP_KEY.anniversary]).toEqual({
			at: 77,
			granularity: DateGranularity.Date,
		});
		expect(PERSON_PROP_KEY.anniversary in personToValues(makePerson())).toBe(false);
	});
	it("has no bio row — free-form notes live in the body editor", () => {
		expect("bio" in personToValues(makePerson())).toBe(false);
	});
	it("carries the company ref id (the cell resolves the title), or blank", () => {
		expect(personToValues(makePerson())[PERSON_PROP_KEY.company]).toBe("co_1");
		expect(personToValues(makePerson({ companyId: null }))[PERSON_PROP_KEY.company]).toBe("");
	});
	it("maps related-people link ids to labeled entity-ref values", () => {
		const values = personToValues(makePerson({ linkIds: ["p2", "p3"] }));
		expect(values[PERSON_PROP_KEY.links]).toEqual([{ value: "p2" }, { value: "p3" }]);
	});
});

describe("splitMultiValue", () => {
	it("splits on newlines and commas, dropping blanks", () => {
		expect(splitMultiValue("a@x.com\n\nb@x.com, c@x.com")).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
	});
	it("is empty for a non-string", () => {
		expect(splitMultiValue(42)).toEqual([]);
	});
});

describe("applyPersonPropertyValue", () => {
	it("splits email / phone back into arrays", () => {
		expect(applyPersonPropertyValue(PERSON_PROP_KEY.email, "a@x.com\nb@x.com")).toEqual({
			email: ["a@x.com", "b@x.com"],
		});
		expect(applyPersonPropertyValue(PERSON_PROP_KEY.phone, "+1, +2")).toEqual({
			phone: ["+1", "+2"],
		});
	});
	it("trims role", () => {
		expect(applyPersonPropertyValue(PERSON_PROP_KEY.role, "  Founder ")).toEqual({
			role: "Founder",
		});
	});
	it("rejects the removed bio key (body editor owns notes)", () => {
		expect(applyPersonPropertyValue("bio", "line")).toBeNull();
	});
	it("reads the epoch out of a DateValue", () => {
		expect(
			applyPersonPropertyValue(PERSON_PROP_KEY.birthday, {
				at: 99,
				granularity: DateGranularity.Date,
			}),
		).toEqual({ birthday: 99 });
		expect(applyPersonPropertyValue(PERSON_PROP_KEY.birthday, null)).toEqual({ birthday: null });
		expect(
			applyPersonPropertyValue(PERSON_PROP_KEY.anniversary, {
				at: 7,
				granularity: DateGranularity.Date,
			}),
		).toEqual({ anniversary: 7 });
	});
	it("maps a picked company ref id back to the company property (or null)", () => {
		expect(applyPersonPropertyValue(PERSON_PROP_KEY.company, "co_2")).toEqual({ company: "co_2" });
		expect(applyPersonPropertyValue(PERSON_PROP_KEY.company, null)).toEqual({ company: null });
	});
	it("maps related-people ref values back to a links id array", () => {
		expect(
			applyPersonPropertyValue(PERSON_PROP_KEY.links, [{ value: "p2" }, { value: "p3" }]),
		).toEqual({ links: ["p2", "p3"] });
		expect(applyPersonPropertyValue(PERSON_PROP_KEY.links, ["p4"])).toEqual({ links: ["p4"] });
		expect(applyPersonPropertyValue(PERSON_PROP_KEY.links, null)).toEqual({ links: [] });
	});
});

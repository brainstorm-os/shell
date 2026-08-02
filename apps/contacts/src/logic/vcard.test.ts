import { describe, expect, it } from "vitest";
import type { Person } from "../types/person";
import {
	type VCardContact,
	parseVCardDate,
	parseVCards,
	personToVCard,
	serializeVCard,
	serializeVCards,
} from "./vcard";

function contact(over: Partial<VCardContact> = {}): VCardContact {
	return {
		name: "Ada Okafor",
		emails: ["ada@x.com"],
		phones: [],
		org: null,
		role: null,
		birthday: null,
		anniversary: null,
		note: null,
		...over,
	};
}

// Local-noon anchors so the date round-trips exactly (parse anchors at noon).
const BDAY = new Date(1990, 5, 10, 12, 0, 0).getTime();
const ANNIV = new Date(2018, 5, 10, 12, 0, 0).getTime();

describe("serializeVCard", () => {
	it("emits the required envelope + mapped fields", () => {
		const vcf = serializeVCard(
			contact({
				emails: ["ada@x.com", "a2@x.com"],
				phones: ["+1 555"],
				org: "Acme Corp",
				role: "Founder",
				birthday: BDAY,
				anniversary: ANNIV,
				note: "Met at summit",
			}),
		);
		expect(vcf.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n")).toBe(true);
		expect(vcf).toContain("FN:Ada Okafor");
		expect(vcf).toContain("N:Okafor;Ada;;;");
		expect(vcf).toContain("EMAIL:ada@x.com");
		expect(vcf).toContain("EMAIL:a2@x.com");
		expect(vcf).toContain("TEL:+1 555");
		expect(vcf).toContain("ORG:Acme Corp");
		expect(vcf).toContain("TITLE:Founder");
		expect(vcf).toContain("BDAY:1990-06-10");
		expect(vcf).toContain("ANNIVERSARY:2018-06-10");
		expect(vcf).toContain("NOTE:Met at summit");
		expect(vcf.endsWith("END:VCARD\r\n")).toBe(true);
	});

	it("omits unset optional lines", () => {
		const vcf = serializeVCard(contact());
		expect(vcf).not.toContain("ORG:");
		expect(vcf).not.toContain("BDAY:");
		expect(vcf).not.toContain("ANNIVERSARY:");
		expect(vcf).not.toContain("NOTE:");
	});

	it("escapes commas, semicolons, backslashes and newlines in values", () => {
		const vcf = serializeVCard(contact({ note: "a, b; c\\d\nnext" }));
		expect(vcf).toContain("NOTE:a\\, b\\; c\\\\d\\nnext");
	});
});

describe("parseVCards", () => {
	it("round-trips a serialized contact", () => {
		const original = contact({
			phones: ["+1 555"],
			org: "Acme Corp",
			role: "Founder",
			birthday: BDAY,
			anniversary: ANNIV,
			note: "line one\nline two",
		});
		const [parsed] = parseVCards(serializeVCards([original]));
		expect(parsed).toEqual(original);
	});

	it("parses multiple cards", () => {
		const doc = `${serializeVCard(contact({ name: "Ada" }))}${serializeVCard(contact({ name: "Lin", emails: ["lin@x.com"] }))}`;
		const parsed = parseVCards(doc);
		expect(parsed.map((c) => c.name)).toEqual(["Ada", "Lin"]);
	});

	it("tolerates vCard 4.0 + compact dates and LF line endings", () => {
		const doc = [
			"BEGIN:VCARD",
			"VERSION:4.0",
			"FN:Mara Silva",
			"EMAIL;TYPE=work:mara@x.com",
			"BDAY:19970214",
			"END:VCARD",
		].join("\n");
		const [parsed] = parseVCards(doc);
		expect(parsed?.name).toBe("Mara Silva");
		expect(parsed?.emails).toEqual(["mara@x.com"]);
		expect(parsed?.birthday).toBe(new Date(1997, 1, 14, 12, 0, 0).getTime());
	});

	it("derives a name from N when FN is absent", () => {
		const doc = "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Zhao;Lin;;;\r\nEMAIL:lin@x.com\r\nEND:VCARD\r\n";
		expect(parseVCards(doc)[0]?.name).toBe("Lin Zhao");
	});

	it("unfolds RFC-6350 continuation lines", () => {
		const doc = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Very Long\r\n  Name Here\r\nEND:VCARD\r\n";
		expect(parseVCards(doc)[0]?.name).toBe("Very Long Name Here");
	});

	it("ignores unknown properties and drops identity-less cards", () => {
		const doc =
			"BEGIN:VCARD\r\nVERSION:3.0\r\nX-CUSTOM:whatever\r\nEND:VCARD\r\n" +
			"BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Kenji\r\nEND:VCARD\r\n";
		const parsed = parseVCards(doc);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.name).toBe("Kenji");
	});

	it("takes the first ORG component", () => {
		const doc = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada\r\nORG:Acme Corp;R&D;Team\r\nEND:VCARD\r\n";
		expect(parseVCards(doc)[0]?.org).toBe("Acme Corp");
	});
});

describe("parseVCardDate", () => {
	it("parses dashed and compact forms at local noon", () => {
		expect(parseVCardDate("1990-06-10")).toBe(new Date(1990, 5, 10, 12, 0, 0).getTime());
		expect(parseVCardDate("19900610")).toBe(new Date(1990, 5, 10, 12, 0, 0).getTime());
		expect(parseVCardDate("1990-06-10T09:00:00Z")).toBe(new Date(1990, 5, 10, 12, 0, 0).getTime());
	});
	it("returns null for year-less or invalid values", () => {
		expect(parseVCardDate("--0610")).toBeNull();
		expect(parseVCardDate("not-a-date")).toBeNull();
		expect(parseVCardDate("1990-13-40")).toBeNull();
	});
});

describe("personToVCard", () => {
	function person(over: Partial<Person> = {}): Person {
		return {
			id: "p1",
			name: "Ada Okafor",
			emails: ["ada@x.com"],
			phones: ["+1 555"],
			companyId: "co_1",
			role: "Founder",
			birthday: BDAY,
			anniversary: null,
			linkIds: [],
			bio: "hi",
			icon: null,
			cover: null,
			...over,
		};
	}
	it("maps a person + resolved company name", () => {
		expect(personToVCard(person(), "Acme Corp")).toEqual({
			name: "Ada Okafor",
			emails: ["ada@x.com"],
			phones: ["+1 555"],
			org: "Acme Corp",
			role: "Founder",
			birthday: BDAY,
			anniversary: null,
			note: "hi",
		});
	});
	it("collapses empty scalars to null", () => {
		const v = personToVCard(person({ role: "  ", bio: "", companyId: null }), null);
		expect(v.org).toBeNull();
		expect(v.role).toBeNull();
		expect(v.note).toBeNull();
	});
});

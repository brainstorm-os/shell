import { PropertyFormat, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { buildContactProperties, seedContactProperties } from "./contact-properties";

describe("buildContactProperties", () => {
	const props = buildContactProperties();
	const byKey = (k: string) => props.find((p) => p.key === k);

	it("models Email/Phone as Text + format (not a value-kind), multi-valued", () => {
		const email = byKey("email");
		expect(email?.valueType).toBe(ValueType.Text);
		expect(email?.format).toBe(PropertyFormat.Email);
		expect((email?.count?.max ?? 1) > 1).toBe(true);

		const phone = byKey("phone");
		expect(phone?.valueType).toBe(ValueType.Text);
		expect(phone?.format).toBe(PropertyFormat.Phone);
	});

	it("uses the right base types for the structured fields", () => {
		expect(byKey("birthday")?.valueType).toBe(ValueType.Date);
		expect(byKey("bio")?.valueType).toBe(ValueType.RichText);
		expect(byKey("links")?.valueType).toBe(ValueType.EntityRef);
		expect(byKey("links")?.allowedTypes).toContain("brainstorm/Person/v1");
		expect(byKey("company")?.valueType).toBe(ValueType.EntityRef);
		expect(byKey("company")?.allowedTypes).toContain("brainstorm/Company/v1");
	});

	it("does not redefine the shared display key `name`", () => {
		expect(byKey("name")).toBeUndefined();
	});
});

describe("seedContactProperties", () => {
	it("writes every Person property through the session store", async () => {
		const written: string[] = [];
		const store = { setProperty: vi.fn((d) => written.push(d.key)) };
		const result = await seedContactProperties({ propertiesStore: async () => store });
		expect(result).toEqual({ ok: true, properties: buildContactProperties().length });
		expect(written).toEqual(buildContactProperties().map((p) => p.key));
	});

	it("reports a reason instead of throwing when the store rejects", async () => {
		const result = await seedContactProperties({
			propertiesStore: async () => {
				throw new Error("no active vault session");
			},
		});
		expect(result).toEqual({ ok: false, reason: "no active vault session" });
	});
});

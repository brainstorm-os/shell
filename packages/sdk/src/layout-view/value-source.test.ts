import { describe, expect, it, vi } from "vitest";
import { createLayoutValueSource, staticLayoutValueSource } from "./value-source";

describe("createLayoutValueSource", () => {
	it("reads seeded values and undefined for unset keys", () => {
		const source = createLayoutValueSource({ name: "Ada" });
		expect(source.get("name")).toBe("Ada");
		expect(source.get("email")).toBeUndefined();
	});

	it("notifies ONLY the written property's subscribers", () => {
		const source = createLayoutValueSource({ name: "Ada", email: "a@b.c" });
		const onName = vi.fn();
		const onEmail = vi.fn();
		source.subscribe("name", onName);
		source.subscribe("email", onEmail);

		source.set("name", "Grace");

		expect(onName).toHaveBeenCalledOnce();
		expect(onEmail).not.toHaveBeenCalled();
	});

	it("does not notify when the value is unchanged (a no-op write must not repaint)", () => {
		const source = createLayoutValueSource({ name: "Ada" });
		const onName = vi.fn();
		source.subscribe("name", onName);
		source.set("name", "Ada");
		expect(onName).not.toHaveBeenCalled();
	});

	it("unsubscribe stops delivery", () => {
		const source = createLayoutValueSource({});
		const listener = vi.fn();
		const off = source.subscribe("name", listener);
		off();
		source.set("name", "x");
		expect(listener).not.toHaveBeenCalled();
	});

	it("supports several listeners on one key", () => {
		const source = createLayoutValueSource({});
		const a = vi.fn();
		const b = vi.fn();
		source.subscribe("name", a);
		source.subscribe("name", b);
		source.set("name", "x");
		expect(a).toHaveBeenCalledOnce();
		expect(b).toHaveBeenCalledOnce();
	});

	it("reset notifies only the keys that actually changed, including removals", () => {
		const source = createLayoutValueSource({ name: "Ada", email: "a@b.c" });
		const onName = vi.fn();
		const onEmail = vi.fn();
		const onPhone = vi.fn();
		source.subscribe("name", onName);
		source.subscribe("email", onEmail);
		source.subscribe("phone", onPhone);

		source.reset({ name: "Ada", phone: "555" });

		expect(onName).not.toHaveBeenCalled();
		expect(onEmail).toHaveBeenCalledOnce();
		expect(onPhone).toHaveBeenCalledOnce();
		expect(source.get("email")).toBeUndefined();
	});

	it("snapshot is a fresh object per write, so identity signals change", () => {
		const source = createLayoutValueSource({ name: "Ada" });
		const before = source.snapshot();
		source.set("name", "Grace");
		expect(source.snapshot()).not.toBe(before);
		expect(before.name).toBe("Ada");
	});

	it("a listener unsubscribing during notify does not skip its peers", () => {
		const source = createLayoutValueSource({});
		const seen: string[] = [];
		const off = source.subscribe("k", () => {
			seen.push("first");
			off();
		});
		source.subscribe("k", () => seen.push("second"));
		source.set("k", 1);
		expect(seen).toEqual(["first", "second"]);
	});
});

describe("staticLayoutValueSource", () => {
	it("reads through and never notifies", () => {
		const source = staticLayoutValueSource({ name: "Ada" });
		expect(source.get("name")).toBe("Ada");
		const off = source.subscribe("name", () => {
			throw new Error("static source must never notify");
		});
		expect(() => off()).not.toThrow();
	});
});

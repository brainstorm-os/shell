import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dictionary, PropertyDef } from "@brainstorm-os/sdk-types";
import { ValueType } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { YDocStore } from "../storage/ydoc-store";
import { makePropertiesServiceHandler } from "./properties-service";
import { PropertiesStore } from "./properties-store";

const APP = "io.example.notes";

function envelope(method: string, args: unknown[]): Envelope {
	return {
		v: 1,
		msg: "m_test",
		app: APP,
		service: "properties",
		method,
		args,
		caps: ["properties.read", "properties.write"],
	};
}

const textProperty = (key: string, name = "Title"): PropertyDef => ({
	key,
	name,
	icon: null,
	valueType: ValueType.Text,
});

const dictionary = (id: string, name = "Status"): Dictionary => ({
	id,
	name,
	items: [
		{ id: "di_a", label: "Todo", icon: null, sortIndex: 0 },
		{ id: "di_b", label: "Doing", icon: null, sortIndex: 1 },
	],
});

describe("makePropertiesServiceHandler", () => {
	let vaultDir: string;
	let yStore: YDocStore;
	let store: PropertiesStore;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-properties-svc-"));
		yStore = new YDocStore(vaultDir);
		store = await PropertiesStore.open(yStore);
	});

	afterEach(async () => {
		await store.flush();
		await store.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("list returns the empty snapshot on a fresh store", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => store });
		const result = await handler(envelope("list", []));
		expect(result).toEqual({ properties: {}, dictionaries: {} });
	});

	it("setProperty + list round-trips through the broker shape", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => store });
		await handler(envelope("setProperty", [{ def: textProperty("prop_a", "Title") }]));
		const result = (await handler(envelope("list", []))) as {
			properties: Record<string, PropertyDef>;
		};
		expect(result.properties.prop_a?.name).toBe("Title");
	});

	it("getProperty returns the def or null", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => store });
		await handler(envelope("setProperty", [{ def: textProperty("prop_a") }]));
		const found = await handler(envelope("getProperty", [{ key: "prop_a" }]));
		expect((found as PropertyDef).key).toBe("prop_a");

		const missing = await handler(envelope("getProperty", [{ key: "prop_missing" }]));
		expect(missing).toBeNull();
	});

	it("removeProperty erases the entry", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => store });
		await handler(envelope("setProperty", [{ def: textProperty("prop_a") }]));
		await handler(envelope("removeProperty", [{ key: "prop_a" }]));
		const snap = (await handler(envelope("list", []))) as {
			properties: Record<string, PropertyDef>;
		};
		expect(snap.properties).toEqual({});
	});

	it("setDictionary + getDictionary round-trip", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => store });
		await handler(envelope("setDictionary", [{ dict: dictionary("dict_status") }]));
		const found = await handler(envelope("getDictionary", [{ id: "dict_status" }]));
		expect((found as Dictionary).items.length).toBe(2);
	});

	it("removeDictionary erases the entry", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => store });
		await handler(envelope("setDictionary", [{ dict: dictionary("dict_x") }]));
		await handler(envelope("removeDictionary", [{ id: "dict_x" }]));
		const snap = (await handler(envelope("list", []))) as {
			dictionaries: Record<string, Dictionary>;
		};
		expect(snap.dictionaries).toEqual({});
	});

	it("throws Unavailable when no store is wired (no active vault session)", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => null });
		await expect(handler(envelope("list", []))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("rejects unknown methods with Invalid", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => store });
		await expect(handler(envelope("nonsense", [{}]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("rejects setProperty with a missing def with Invalid", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => store });
		await expect(handler(envelope("setProperty", [{}]))).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(handler(envelope("setProperty", [null]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("rejects setProperty with a validation-failing def with Invalid", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => store });
		// Empty name fails `validatePropertyDef` inside the store; the
		// handler translates the throw into a structured Invalid.
		await expect(
			handler(envelope("setProperty", [{ def: { ...textProperty("prop_a"), name: "" } }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("rejects setDictionary with a validation-failing dict with Invalid", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => store });
		const bad: Dictionary = {
			id: "dict_bad",
			name: "Bad",
			items: [
				{ id: "di_dup", label: "One", icon: null, sortIndex: 0 },
				{ id: "di_dup", label: "Two", icon: null, sortIndex: 1 },
			],
		};
		await expect(handler(envelope("setDictionary", [{ dict: bad }]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("rejects {key} / {id} / {def} / {dict} args of wrong shape with Invalid", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => store });
		await expect(handler(envelope("getProperty", [{ key: "" }]))).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(handler(envelope("getDictionary", [{ id: 42 }]))).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(handler(envelope("removeProperty", [{}]))).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(handler(envelope("setDictionary", [{ dict: null }]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("rejects an envelope whose first arg is not an object with Invalid", async () => {
		const handler = makePropertiesServiceHandler({ getStore: async () => store });
		await expect(handler(envelope("getProperty", ["not-an-object"]))).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(handler(envelope("setProperty", [["array"]]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});
});

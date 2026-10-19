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

const BOOK = "io.example/Book/v1";
const PERSON = "io.example/Person/v1";
const THING = "io.example/Thing/v1";

const refProperty = (key: string, extra: Partial<PropertyDef> = {}): PropertyDef => ({
	key,
	name: key,
	icon: null,
	valueType: ValueType.EntityRef,
	...extra,
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

	describe("pair gate (9.12.25)", () => {
		function grantedHandler(
			grants: ReadonlySet<string>,
			gateOpen: Promise<void> = Promise.resolve(),
		) {
			return makePropertiesServiceHandler({
				getStore: async () => store,
				canWriteType: async (_app, type) => {
					await gateOpen;
					return grants.has(type);
				},
			});
		}

		it("concurrent setProperty calls cannot interleave past the gate (reshape of a fresh partner)", async () => {
			store.setProperty(refProperty("books", { allowedTypes: [BOOK] }));
			let release!: () => void;
			const gateOpen = new Promise<void>((resolve) => {
				release = resolve;
			});
			const handler = grantedHandler(new Set([BOOK]), gateOpen);

			const pairing = handler(
				envelope("setProperty", [
					{ def: refProperty("authors", { allowedTypes: [BOOK], inverseOf: "books" }) },
				]),
			);
			const widening = handler(
				envelope("setProperty", [{ def: refProperty("books", { allowedTypes: [PERSON] }) }]),
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			release();

			await expect(pairing).resolves.toBeUndefined();
			await expect(widening).rejects.toMatchObject({ name: "Denied" });
			const snap = store.snapshot().properties;
			expect(snap.authors?.inverseOf).toBe("books");
			expect(snap.books?.allowedTypes).toEqual([BOOK]);
		});

		it("reads stay unserialised while a mutation waits on the gate", async () => {
			let release!: () => void;
			const gateOpen = new Promise<void>((resolve) => {
				release = resolve;
			});
			const handler = grantedHandler(new Set([BOOK]), gateOpen);
			const pairing = handler(
				envelope("setProperty", [
					{ def: refProperty("authors", { allowedTypes: [BOOK], inverseOf: "books" }) },
				]),
			);
			const listed = await Promise.race([
				handler(envelope("list", [])),
				new Promise((_, reject) => setTimeout(() => reject(new Error("list blocked")), 200)),
			]);
			expect(listed).toEqual({ properties: {}, dictionaries: {} });
			release();
			await expect(pairing).rejects.toMatchObject({ name: "Denied" });
		});

		it("a third def naming one half of a pair is gated over the partner's partner too", async () => {
			store.setProperty(refProperty("authors", { allowedTypes: [BOOK], inverseOf: "books" }));
			store.setProperty(refProperty("books", { allowedTypes: [PERSON], inverseOf: "authors" }));
			const def = refProperty("editors", { allowedTypes: [THING], inverseOf: "authors" });

			const narrow = grantedHandler(new Set([BOOK, THING]));
			await expect(narrow(envelope("setProperty", [{ def }]))).rejects.toMatchObject({
				name: "Denied",
			});
			expect(store.snapshot().properties.editors).toBeUndefined();

			const wide = grantedHandler(new Set([BOOK, THING, PERSON]));
			await expect(wide(envelope("setProperty", [{ def }]))).resolves.toBeUndefined();
			expect(store.snapshot().properties.editors?.inverseOf).toBe("authors");
		});

		it("the pair walk closes over a chain in both directions and terminates on a cycle", async () => {
			store.setProperty(refProperty("a", { allowedTypes: [BOOK], inverseOf: "b" }));
			store.setProperty(refProperty("b", { allowedTypes: [BOOK], inverseOf: "c" }));
			store.setProperty(refProperty("c", { allowedTypes: [PERSON], inverseOf: "a" }));

			const narrow = grantedHandler(new Set([BOOK, THING]));
			await expect(
				narrow(
					envelope("setProperty", [
						{ def: refProperty("d", { allowedTypes: [THING], inverseOf: "b" }) },
					]),
				),
			).rejects.toMatchObject({ name: "Denied" });
			await expect(narrow(envelope("removeProperty", [{ key: "a" }]))).rejects.toMatchObject({
				name: "Denied",
			});
			expect(Object.keys(store.snapshot().properties).sort()).toEqual(["a", "b", "c"]);
		});
	});
});

import {
	ENTITY_LINKS_ARRAY_NAME,
	ENTITY_PROPS_MAP_NAME,
	UNIVERSAL_BODY_FRAGMENT_NAME,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readEntityDocProjection, writeEntityLinks, writeEntityProps } from "./entity-doc-codec";

describe("entity-doc-codec", () => {
	it("round-trips a property map through write → read", () => {
		const doc = new Y.Doc();
		writeEntityProps(doc, { title: "Buy milk", statusKey: "todo", priority: 2, done: false });
		expect(readEntityDocProjection(doc).properties).toEqual({
			title: "Buy milk",
			statusKey: "todo",
			priority: 2,
			done: false,
		});
	});

	it("merges successive property writes (last value wins per key)", () => {
		const doc = new Y.Doc();
		writeEntityProps(doc, { title: "Draft", statusKey: "todo" });
		writeEntityProps(doc, { statusKey: "done" });
		expect(readEntityDocProjection(doc).properties).toEqual({ title: "Draft", statusKey: "done" });
	});

	it("projects nested JSON values structurally", () => {
		const doc = new Y.Doc();
		writeEntityProps(doc, { tags: ["a", "b"], meta: { color: "red" } });
		expect(readEntityDocProjection(doc).properties).toEqual({
			tags: ["a", "b"],
			meta: { color: "red" },
		});
	});

	it("round-trips links and replaces the full set on rewrite", () => {
		const doc = new Y.Doc();
		writeEntityLinks(doc, [
			{ id: "l1", destEntityId: "p1", linkType: "in-project", createdAt: 10 },
			{ id: "l2", destEntityId: "p2", linkType: "in-project", createdAt: 20 },
		]);
		expect(readEntityDocProjection(doc).links).toEqual([
			{ id: "l1", destEntityId: "p1", linkType: "in-project", createdAt: 10 },
			{ id: "l2", destEntityId: "p2", linkType: "in-project", createdAt: 20 },
		]);
		writeEntityLinks(doc, [{ id: "l3", destEntityId: "p3", linkType: "in-project", createdAt: 30 }]);
		expect(readEntityDocProjection(doc).links).toEqual([
			{ id: "l3", destEntityId: "p3", linkType: "in-project", createdAt: 30 },
		]);
	});

	it("reports absent roots as omitted, not empty — a body-only doc projects to nothing", () => {
		const doc = new Y.Doc();
		// Touch ONLY the universal body root (the legacy / pre-migration shape).
		doc.get(UNIVERSAL_BODY_FRAGMENT_NAME, Y.XmlText).insert(0, "hello");
		const projection = readEntityDocProjection(doc);
		expect(projection.properties).toBeUndefined();
		expect(projection.links).toBeUndefined();
		expect(projection).toEqual({});
	});

	it("omits an empty property map (no keys set)", () => {
		const doc = new Y.Doc();
		doc.getMap(ENTITY_PROPS_MAP_NAME); // materialise but write nothing
		expect(readEntityDocProjection(doc).properties).toBeUndefined();
	});

	it("survives a serialize → load round-trip across docs (the on-disk path)", () => {
		const source = new Y.Doc();
		writeEntityProps(source, { title: "Persisted" });
		writeEntityLinks(source, [{ id: "l1", destEntityId: "x", linkType: "rel", createdAt: 1 }]);
		const update = Y.encodeStateAsUpdate(source);

		const loaded = new Y.Doc();
		Y.applyUpdate(loaded, update);
		const projection = readEntityDocProjection(loaded);
		expect(projection.properties).toEqual({ title: "Persisted" });
		expect(projection.links).toEqual([
			{ id: "l1", destEntityId: "x", linkType: "rel", createdAt: 1 },
		]);
	});

	it("drops malformed link records (defensive against a hand-edited array)", () => {
		const doc = new Y.Doc();
		const arr = doc.getArray<unknown>(ENTITY_LINKS_ARRAY_NAME);
		arr.push([
			{ id: "ok", destEntityId: "d", linkType: "rel", createdAt: 1 },
			{ id: "bad-no-dest", linkType: "rel", createdAt: 2 },
			"garbage",
		]);
		expect(readEntityDocProjection(doc).links).toEqual([
			{ id: "ok", destEntityId: "d", linkType: "rel", createdAt: 1 },
		]);
	});
});

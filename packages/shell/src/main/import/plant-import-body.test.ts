/**
 * Markdown → Lexical state → Y.Doc plant for importers.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { makeEnvelope } from "../../ipc/envelope";
import { handleYDocEnvelope } from "../../workers/ydoc/index";
import { base64ToBytes, bytesToBase64 } from "../credentials/crypto";
import {
	markdownToSerializedState,
	plantImportMarkdownBody,
	plantImportSerializedBody,
} from "./plant-import-body";

describe("markdownToSerializedState", () => {
	it("emits paragraphs, headings, lists, and checklists", () => {
		const state = markdownToSerializedState(
			"## Title\n\nHello **world**\n\n- one\n- two\n\n- [x] done\n- [ ] todo\n",
		);
		const children = (state.root as { children: Array<{ type: string }> }).children;
		const types = children.map((c) => c.type);
		expect(types).toContain("heading");
		expect(types).toContain("paragraph");
		expect(types).toContain("list");
	});

	it("handles empty / whitespace input as a single empty paragraph", () => {
		const state = markdownToSerializedState("   \n  ");
		const children = (state.root as { children: unknown[] }).children;
		expect(children).toHaveLength(1);
	});
});

describe("plantImportMarkdownBody", () => {
	it("writes a non-empty Yjs update for a note body", async () => {
		const vaultPath = "/tmp/plant-import-body-test";
		const entityId = "ent_import_body_test";
		const updates: string[] = [];
		await plantImportMarkdownBody(entityId, "Hello from Anytype\n\nSecond para.", async (id, b64) => {
			expect(id).toBe(entityId);
			updates.push(b64);
			const reply = await handleYDocEnvelope(
				makeEnvelope({
					msg: `p${id}`,
					app: "io.brainstorm.shell",
					service: "ydoc",
					method: "applyUpdate",
					args: [{ vaultPath, entityId: id, updateB64: b64 }],
					caps: [],
				}),
			);
			expect(reply.ok).toBe(true);
		});
		expect(updates).toHaveLength(1);
		const bytes = base64ToBytes(updates[0] as string);
		expect(bytes.byteLength).toBeGreaterThan(10);
		// Round-trip: load should return a non-empty snapshot.
		const load = await handleYDocEnvelope(
			makeEnvelope({
				msg: `l${entityId}`,
				app: "io.brainstorm.shell",
				service: "ydoc",
				method: "load",
				args: [{ vaultPath, entityId }],
				caps: [],
			}),
		);
		if (!load.ok) throw new Error("ydoc load failed");
		const snap = base64ToBytes((load.value as { snapshotB64: string }).snapshotB64);
		const doc = new Y.Doc();
		Y.applyUpdate(doc, snap);
		// Universal body is an XmlFragment/XmlText — just assert the update was real.
		expect(snap.byteLength).toBeGreaterThan(10);
		doc.destroy();
	});

	it("is a no-op for empty markdown", async () => {
		let called = false;
		await plantImportMarkdownBody("ent_x", "  \n", async () => {
			called = true;
		});
		expect(called).toBe(false);
	});
});

describe("plantImportSerializedBody replace semantics (F-398)", () => {
	const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

	it("appends without loadDocSnapshot, replaces with it", async () => {
		const doc = new Y.Doc();
		const applyDocUpdate = async (_id: string, b64: string) => {
			Y.applyUpdate(doc, base64ToBytes(b64));
		};
		const loadDocSnapshot = async () => bytesToBase64(Y.encodeStateAsUpdate(doc));
		const state = (text: string) => markdownToSerializedState(`# ${text}`);

		await plantImportSerializedBody("ent_r", state("first body"), applyDocUpdate);
		expect(count(doc.get("root", Y.XmlText).toString(), "first body")).toBe(1);

		// The legacy path (no snapshot): a second plant APPENDS a full copy —
		// this is exactly the F-398 duplication.
		await plantImportSerializedBody("ent_r", state("first body"), applyDocUpdate);
		expect(count(doc.get("root", Y.XmlText).toString(), "first body")).toBe(2);

		// With the snapshot seam the plant REPLACES: one copy of the new body,
		// zero of the old.
		await plantImportSerializedBody("ent_r", state("second body"), applyDocUpdate, loadDocSnapshot);
		const after = doc.get("root", Y.XmlText).toString();
		expect(count(after, "second body")).toBe(1);
		expect(count(after, "first body")).toBe(0);
		doc.destroy();
	});
});

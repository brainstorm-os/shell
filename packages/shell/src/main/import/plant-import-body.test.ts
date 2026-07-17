/**
 * Markdown → Lexical state → Y.Doc plant for importers.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { makeEnvelope } from "../../ipc/envelope";
import { handleYDocEnvelope } from "../../workers/ydoc/index";
import { base64ToBytes } from "../credentials/crypto";
import { markdownToSerializedState, plantImportMarkdownBody } from "./plant-import-body";

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

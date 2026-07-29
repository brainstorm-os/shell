/**
 * AppForge-3 — propose-code-file staging. Security posture under test:
 * bounded content (oversized REFUSED), sanitized vault-path string,
 * validated language enum, allowlisted fields, and the fail-closed
 * offer-time capability gate.
 */

import { CodeLanguage } from "@brainstorm-os/sdk/language-detect";
import { describe, expect, it } from "vitest";
import { ProposeKind } from "./propose-artifacts";
import {
	CODE_FILE_CONTENT_MAX,
	CODE_FILE_ENTITY_TYPE,
	CODE_FILE_PATH_MAX,
	CODE_FILE_WRITE_CAPABILITY,
	CodeFileRejectReason,
	PROPOSE_CODE_FILE_VERB,
	buildCodeFileProposal,
	buildCodeFileProposalAck,
	canProposeCodeFiles,
	resolveProposedLanguage,
} from "./propose-code-file";

function build(args: Record<string, unknown>, id = "d1") {
	return buildCodeFileProposal({ verb: PROPOSE_CODE_FILE_VERB, args, id });
}

function buildOk(args: Record<string, unknown>) {
	const r = build(args);
	if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
	return r.artifact;
}

describe("buildCodeFileProposal", () => {
	it("stages a bounded draft: path is the summary, content rides verbatim", () => {
		const content = 'console.log("hi");\n';
		const artifact = buildOk({ path: "scripts/hello.ts", content });
		expect(artifact.kind).toBe(ProposeKind.CodeFile);
		expect(artifact.entityType).toBe(CODE_FILE_ENTITY_TYPE);
		expect(artifact.summary).toBe("scripts/hello.ts");
		expect(artifact.fields).toEqual({ path: "scripts/hello.ts", content });
		expect(artifact.codeFile?.language).toBe(CodeLanguage.TypeScript);
	});

	it("drops every arg outside the {path, content} allowlist", () => {
		const artifact = buildOk({
			path: "a.ts",
			content: "x",
			locked: true,
			isDirty: true,
			id: "model-chosen",
			properties: { evil: 1 },
		});
		expect(Object.keys(artifact.fields).sort()).toEqual(["content", "path"]);
		expect(artifact.id).toBe("d1"); // host-minted, never the model's
	});

	it("refuses a missing / empty / non-string path", () => {
		for (const path of [undefined, "", "   ", 42, ["a.ts"]]) {
			const r = build({ path, content: "x" });
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toBe(CodeFileRejectReason.MissingPath);
		}
	});

	it("sanitizes the path like the Code editor's rename: control/bidi strip + clamp", () => {
		// Bidi-override + control chars are the spoofing alphabet — stripped.
		const artifact = buildOk({ path: "evil\u202e\u0007sj.ts", content: "" });
		expect(artifact.fields.path).toBe("evilsj.ts");
		const long = buildOk({ path: `${"a".repeat(500)}.ts`, content: "" });
		expect((long.fields.path ?? "").length).toBe(CODE_FILE_PATH_MAX);
	});

	it("the path stays a vault string — no filesystem semantics are applied", () => {
		// Traversal-shaped input is preserved as inert organizing text (nothing
		// ever resolves it against a disk); the draft is stageable and harmless.
		const artifact = buildOk({ path: "../../etc/passwd", content: "" });
		expect(artifact.fields.path).toBe("../../etc/passwd");
	});

	it("REFUSES oversized content (never silently truncates)", () => {
		const r = build({ path: "big.ts", content: "x".repeat(CODE_FILE_CONTENT_MAX + 1) });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe(CodeFileRejectReason.ContentTooLarge);
		// Exactly at the bound is accepted.
		expect(build({ path: "ok.ts", content: "x".repeat(CODE_FILE_CONTENT_MAX) }).ok).toBe(true);
	});

	it("non-string content degrades to an empty file, not a crash or a blob", () => {
		const artifact = buildOk({ path: "a.ts", content: { evil: true } });
		expect(artifact.fields.content).toBe("");
	});

	it("injection-shaped content is carried as plain data, byte for byte", () => {
		const payload = '<img src=x onerror="alert(1)"><script>steal()</script>';
		const artifact = buildOk({ path: "x.html", content: payload });
		expect(artifact.fields.content).toBe(payload);
	});
});

describe("resolveProposedLanguage", () => {
	it("a valid model-supplied language wins", () => {
		expect(resolveProposedLanguage("python", "x.ts", "")).toBe(CodeLanguage.Python);
	});

	it("an invalid / missing language infers from the extension", () => {
		expect(resolveProposedLanguage("klingon", "x.rs", "")).toBe(CodeLanguage.Rust);
		expect(resolveProposedLanguage(undefined, "manifest.json", "")).toBe(CodeLanguage.JSON);
	});

	it("falls back to the shebang, then PlainText (never Unknown)", () => {
		expect(resolveProposedLanguage(undefined, "run", "#!/usr/bin/env python3")).toBe(
			CodeLanguage.Python,
		);
		expect(resolveProposedLanguage(undefined, "LICENSE", "hello")).toBe(CodeLanguage.PlainText);
		// The model can't force Unknown either — it resolves via inference.
		expect(resolveProposedLanguage("unknown", "x.py", "")).toBe(CodeLanguage.Python);
	});
});

describe("buildCodeFileProposalAck", () => {
	it("a staged draft acks pending-approval and says it is NOT saved", () => {
		const ack = buildCodeFileProposalAck(build({ path: "a.ts", content: "x" }));
		expect(ack.staged).toBe(true);
		expect(ack.status).toBe("pending-approval");
		expect(String(ack.note)).toMatch(/NOT saved/);
	});

	it("a refusal names the reason so the model can correct", () => {
		const ack = buildCodeFileProposalAck(build({ content: "x" }));
		expect(ack).toEqual({ staged: false, reason: CodeFileRejectReason.MissingPath });
	});
});

describe("canProposeCodeFiles (offer-time gate)", () => {
	it("false without the CodeFile write cap — the tool is never offered", () => {
		expect(canProposeCodeFiles([])).toBe(false);
		expect(canProposeCodeFiles(["entities.read:*", "intents.dispatch:propose-code-file"])).toBe(
			false,
		);
		expect(canProposeCodeFiles(["entities.write:brainstorm/Task/v1"])).toBe(false);
	});

	it("true with the exact cap (or a wildcard that implies it)", () => {
		expect(canProposeCodeFiles([CODE_FILE_WRITE_CAPABILITY])).toBe(true);
		expect(canProposeCodeFiles(["entities.write:*"])).toBe(true);
	});
});

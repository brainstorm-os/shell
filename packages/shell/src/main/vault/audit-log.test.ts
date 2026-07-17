import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTestDir } from "../test-support/remove-test-dir";
import { appendAuditEvent, auditLogPath } from "./audit-log";

describe("audit log", () => {
	let vaultDir: string;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-audit-"));
	});

	afterEach(async () => {
		await removeTestDir(vaultDir);
	});

	it("composes the log path under <vault>/logs/audit.log", () => {
		expect(auditLogPath("/path/to/vault")).toMatch(/logs[/\\]audit\.log$/);
	});

	it("creates the logs directory and writes a JSONL event", async () => {
		await appendAuditEvent(vaultDir, {
			kind: "vault.create",
			vaultId: "vlt_test",
		});
		const contents = await readFile(auditLogPath(vaultDir), "utf8");
		expect(contents.endsWith("\n")).toBe(true);
		const record = JSON.parse(contents.trim());
		expect(record.kind).toBe("vault.create");
		expect(record.vaultId).toBe("vlt_test");
		expect(typeof record.ts).toBe("number");
	});

	it("appends multiple events as separate lines", async () => {
		await appendAuditEvent(vaultDir, { kind: "vault.create", vaultId: "vlt_a" });
		await appendAuditEvent(vaultDir, { kind: "vault.open", vaultId: "vlt_a" });
		await appendAuditEvent(vaultDir, { kind: "vault.activate", vaultId: "vlt_a" });
		const contents = await readFile(auditLogPath(vaultDir), "utf8");
		const lines = contents.trim().split("\n");
		expect(lines).toHaveLength(3);
		expect(lines.map((l) => JSON.parse(l).kind)).toEqual([
			"vault.create",
			"vault.open",
			"vault.activate",
		]);
	});

	it("uses the supplied timestamp when given", async () => {
		const ts = Date.parse("2026-05-11T10:00:00Z");
		await appendAuditEvent(vaultDir, { kind: "vault.create", vaultId: "vlt_a", ts });
		const record = JSON.parse((await readFile(auditLogPath(vaultDir), "utf8")).trim());
		expect(record.ts).toBe(ts);
	});

	it("preserves extra metadata fields", async () => {
		await appendAuditEvent(vaultDir, {
			kind: "vault.create",
			vaultId: "vlt_x",
			name: "Work",
			color: "#7c3aed",
		});
		const record = JSON.parse((await readFile(auditLogPath(vaultDir), "utf8")).trim());
		expect(record.name).toBe("Work");
		expect(record.color).toBe("#7c3aed");
	});

	it("does not throw on filesystem failures", async () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await expect(
			appendAuditEvent("/this/path/cannot/exist/and/is/not/writable", {
				kind: "vault.create",
				vaultId: "vlt_x",
			}),
		).resolves.toBeUndefined();
		spy.mockRestore();
	});
});

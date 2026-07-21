import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpTransportKind } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAX_MCP_SERVERS,
	MCP_ENABLEMENT_FILENAME,
	MCP_SERVERS_FILENAME,
	getApprovedFingerprints,
	listMcpServers,
	removeMcpServer,
	setApprovedFingerprints,
	setMcpServerEnabled,
	upsertMcpServer,
} from "./mcp-config-store";

let vaultPath: string;

beforeEach(async () => {
	vaultPath = await mkdtemp(join(tmpdir(), "mcp-config-"));
});
afterEach(async () => {
	await rm(vaultPath, { recursive: true, force: true });
});

const httpServer = {
	id: "github",
	name: "GitHub",
	transport: McpTransportKind.StreamableHttp,
	url: "https://mcp.example.com/github",
	requiresAuth: true,
};

describe("per-vault config record (OQ-MCP-1)", () => {
	it("upserts + lists a server; new servers default DISABLED on this device", async () => {
		const saved = await upsertMcpServer(vaultPath, httpServer);
		expect(saved?.id).toBe("github");
		const [view] = await listMcpServers(vaultPath);
		expect(view?.name).toBe("GitHub");
		// Per-device enablement: a freshly configured server is NOT enabled
		// anywhere until the device opts in (fail-closed).
		expect(view?.enabledHere).toBe(false);
	});

	it("rejects an HTTP server with no/invalid URL", async () => {
		expect(await upsertMcpServer(vaultPath, { ...httpServer, url: "not a url" })).toBeNull();
	});

	it("rejects an invalid (injection) server id", async () => {
		expect(await upsertMcpServer(vaultPath, { ...httpServer, id: "../evil" })).toBeNull();
	});

	it("preserves createdAt on replace", async () => {
		const first = await upsertMcpServer(vaultPath, httpServer);
		await new Promise((r) => setTimeout(r, 2));
		const second = await upsertMcpServer(vaultPath, { ...httpServer, name: "GH" });
		expect(second?.createdAt).toBe(first?.createdAt);
		expect((second?.updatedAt ?? 0) >= (first?.updatedAt ?? 0)).toBe(true);
	});

	it("enforces the server cap on new ids", async () => {
		for (let i = 0; i < MAX_MCP_SERVERS; i++) {
			await upsertMcpServer(vaultPath, { ...httpServer, id: `s${i}` });
		}
		expect(await upsertMcpServer(vaultPath, { ...httpServer, id: "overflow" })).toBeNull();
		// But replacing an existing id still works at the cap.
		expect(await upsertMcpServer(vaultPath, { ...httpServer, id: "s0", name: "x" })).not.toBeNull();
	});
});

describe("per-device enablement (NOT synced)", () => {
	it("toggles enablement in the .local. file, leaving the record untouched", async () => {
		await upsertMcpServer(vaultPath, httpServer);
		expect(await setMcpServerEnabled(vaultPath, "github", true)).toBe(true);
		const [view] = await listMcpServers(vaultPath);
		expect(view?.enabledHere).toBe(true);
		// Enablement lives in the .local. file, NOT the synced record.
		const local = await import("node:fs/promises").then((fs) =>
			fs.readFile(join(vaultPath, "shell", MCP_ENABLEMENT_FILENAME), "utf8"),
		);
		expect(local).toContain("github");
		const record = await import("node:fs/promises").then((fs) =>
			fs.readFile(join(vaultPath, "shell", MCP_SERVERS_FILENAME), "utf8"),
		);
		expect(record).not.toContain("enabled");
	});

	it("cannot enable a server that isn't configured", async () => {
		expect(await setMcpServerEnabled(vaultPath, "ghost", true)).toBe(false);
	});
});

describe("approved fingerprints (rug-pull baseline, per-device)", () => {
	it("round-trips the approval baseline", async () => {
		await upsertMcpServer(vaultPath, httpServer);
		await setApprovedFingerprints(vaultPath, "github", { search: "fp1" });
		expect(await getApprovedFingerprints(vaultPath, "github")).toEqual({ search: "fp1" });
	});

	it("returns empty for an unknown / unapproved server", async () => {
		expect(await getApprovedFingerprints(vaultPath, "github")).toEqual({});
	});
});

describe("removeMcpServer", () => {
	it("drops the record + per-device state", async () => {
		await upsertMcpServer(vaultPath, httpServer);
		await setMcpServerEnabled(vaultPath, "github", true);
		await setApprovedFingerprints(vaultPath, "github", { search: "fp1" });
		expect(await removeMcpServer(vaultPath, "github")).toBe(true);
		expect(await listMcpServers(vaultPath)).toEqual([]);
		expect(await getApprovedFingerprints(vaultPath, "github")).toEqual({});
		expect(await removeMcpServer(vaultPath, "github")).toBe(false);
	});
});

describe("fail-closed on corrupt config", () => {
	it("drops a corrupt/hand-edited record entry rather than loading it", async () => {
		const fs = await import("node:fs/promises");
		await fs.mkdir(join(vaultPath, "shell"), { recursive: true });
		await writeFile(
			join(vaultPath, "shell", MCP_SERVERS_FILENAME),
			JSON.stringify({
				v: 1,
				servers: {
					good: { ...httpServer, id: "good" },
					bad: { id: "bad", name: "", transport: "nope" },
				},
			}),
			"utf8",
		);
		const list = await listMcpServers(vaultPath);
		expect(list.map((s) => s.id)).toEqual(["good"]);
	});
});

describe("stdio servers (MCP-2)", () => {
	const stdioServer = {
		id: "fs",
		name: "Filesystem",
		transport: McpTransportKind.Stdio,
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
		requiresAuth: false,
	};

	it("persists a stdio server's command + args (no URL)", async () => {
		const saved = await upsertMcpServer(vaultPath, stdioServer);
		expect(saved?.command).toBe("npx");
		expect(saved?.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/data"]);
		expect(saved?.url).toBeUndefined();
		const [view] = await listMcpServers(vaultPath);
		expect(view?.command).toBe("npx");
	});

	it("defaults args to [] when omitted", async () => {
		const saved = await upsertMcpServer(vaultPath, {
			id: "noargs",
			name: "No Args",
			transport: McpTransportKind.Stdio,
			command: "my-server",
			requiresAuth: false,
		});
		expect(saved?.args).toEqual([]);
	});

	it("DROPS a stdio server with no command (fail-closed — not spawnable)", async () => {
		const saved = await upsertMcpServer(vaultPath, {
			id: "nocmd",
			name: "No Command",
			transport: McpTransportKind.Stdio,
			requiresAuth: false,
		});
		expect(saved).toBeNull();
		expect(await listMcpServers(vaultPath)).toEqual([]);
	});
});

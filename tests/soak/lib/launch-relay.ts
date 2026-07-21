/**
 * Stage 10.9a — launch the `@brainstorm-os/relay-server` CLI under a child
 * process for the soak harness. Two real `_electron.launch` shell
 * instances connect to this relay via `ws://localhost:<port>` and exchange
 * encrypted frames; the audit log captured at `auditLogPath` is the input
 * to the ciphertext-only assertion.
 *
 * The `--require` hook on the relay child loads `no-noble-probe.cjs`,
 * which intercepts `Module.prototype.require` and throws if anything
 * tries to import `@noble/*` from inside the relay process. The relay
 * is structurally relay-blind (12th CI fence) — this is the runtime
 * complement of that static check: a relay that links no noble code at
 * runtime cannot possibly decrypt frame bodies, no matter what.
 *
 * SIGTERM teardown waits up to 2 s for the relay to exit cleanly, then
 * SIGKILLs it. The Playwright test owns the lifetime; on assertion fail
 * the `finally` block still tears the relay down so the soak doesn't
 * leak a Bun process across runs.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, openSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const RELAY_BIN = join(REPO_ROOT, "packages", "relay-server", "bin", "relay.ts");
const NO_NOBLE_PROBE = join(__dirname, "no-noble-probe.cjs");

export type LaunchRelayOptions = {
	auditLogPath: string;
	port?: number;
	extraEnv?: Record<string, string>;
	/** Optional file path. When set, the relay child's stdout + stderr
	 *  are tee'd to this file. The 10.9d step-2 instrumentation logs
	 *  per-message + per-route decisions here so a failed soak run leaves
	 *  a forensic trail without inflating CI output. */
	stdioCapturePath?: string;
};

export type RelayHandle = {
	readonly port: number;
	readonly url: string;
	stop(): Promise<void>;
};

export async function launchRelay(options: LaunchRelayOptions): Promise<RelayHandle> {
	const port = options.port ?? (await findFreePort());
	const child = spawn(
		"bun",
		[
			"--bun",
			"--require",
			NO_NOBLE_PROBE,
			RELAY_BIN,
			"--port",
			String(port),
			"--audit-log-path",
			options.auditLogPath,
		],
		{
			cwd: REPO_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				BRAINSTORM_SOAK_NO_NOBLE_PROBE: "1",
				...(options.extraEnv ?? {}),
			},
		},
	);

	const stdoutLines: string[] = [];
	const stderrLines: string[] = [];
	// Truncate the capture file once before the relay starts producing
	// output so re-runs aren't ambiguous (last run wins, no append-history).
	if (options.stdioCapturePath) {
		try {
			openSync(options.stdioCapturePath, "w");
		} catch {
			// best-effort; if we can't create the file we still record in-memory
		}
	}
	const captureLine = (label: "OUT" | "ERR", chunk: string): void => {
		if (!options.stdioCapturePath) return;
		try {
			appendFileSync(options.stdioCapturePath, `[relay/${label}] ${chunk}`);
		} catch {
			// best-effort
		}
	};
	child.stdout?.on("data", (chunk) => {
		const text = String(chunk);
		stdoutLines.push(text);
		captureLine("OUT", text);
	});
	child.stderr?.on("data", (chunk) => {
		const text = String(chunk);
		stderrLines.push(text);
		captureLine("ERR", text);
	});

	await waitForListen(child, port, stdoutLines, stderrLines, 10_000);

	return {
		port,
		url: `ws://127.0.0.1:${port}`,
		stop: () => stopChild(child),
	};
}

function waitForListen(
	child: ChildProcess,
	port: number,
	stdoutLines: readonly string[],
	stderrLines: readonly string[],
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		let resolved = false;
		const onExit = (code: number | null) => {
			if (resolved) return;
			resolved = true;
			reject(
				new Error(
					`relay child exited (${code}) before listening; stdout=${stdoutLines.join("")} stderr=${stderrLines.join("")}`,
				),
			);
		};
		child.once("exit", onExit);

		const probe = (): void => {
			const sock = createConnection({ host: "127.0.0.1", port }, () => {
				sock.end();
				if (resolved) return;
				resolved = true;
				child.off("exit", onExit);
				resolve();
			});
			sock.on("error", () => {
				if (resolved) return;
				if (Date.now() > deadline) {
					resolved = true;
					child.off("exit", onExit);
					reject(new Error(`relay did not listen on :${port} within ${timeoutMs}ms`));
					return;
				}
				setTimeout(probe, 150);
			});
		};
		setTimeout(probe, 100);
	});
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const timeoutMs = 2_000;
	await new Promise<void>((res) => {
		const t = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			res();
		}, timeoutMs);
		child.once("exit", () => {
			clearTimeout(t);
			res();
		});
	});
}

function findFreePort(): Promise<number> {
	return new Promise((resolveFn, rejectFn) => {
		const server = createServer();
		server.unref();
		server.on("error", rejectFn);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr && typeof addr === "object") {
				const port = addr.port;
				server.close(() => resolveFn(port));
			} else {
				server.close();
				rejectFn(new Error("findFreePort: address() returned unexpected shape"));
			}
		});
	});
}

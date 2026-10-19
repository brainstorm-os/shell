import { join } from "node:path";
import { type UtilityProcess, app, utilityProcess } from "electron";
import { Broker } from "../ipc/broker";
import type { Envelope, EnvelopeReply } from "../ipc/envelope";
import { LogLevel, logDiagnostic } from "./diagnostics/error-log";
import {
	type ExtractionWorkerHandle,
	createExtractionWorkerHandle,
} from "./extraction/extraction-worker-handle";
import { gateYDocService } from "./ipc/ydoc-service-gate";
import { type ResilientWorker, createResilientWorker } from "./resilient-worker";
import { BrokerContext } from "./runtime/broker-context";
import { getActiveVaultSession } from "./vault/session";

type WorkerName = "storage" | "ydoc" | "extraction" | "mailbox";

/**
 * Wire worker processes per.
 *
 *   Each worker is a `utilityProcess.fork`. The shell main process is the
 *   router — every host-service call goes through the broker, which forwards
 *   to the appropriate worker.
 *
 * Stage 1 spawned only the storage worker (with a `ping` stub). Stage 3 adds
 * the **ydoc worker** (OQ-18 resolution: canonical Y.Docs live in a dedicated
 * process to keep the main loop's perf budget intact).
 */

function workerPath(mainDir: string, name: WorkerName): string {
	return join(mainDir, `workers/${name}.js`);
}

/** Adapter from Electron's UtilityProcess (one-way event) to the duplex shape
 *  WorkerBridge expects. UtilityProcess uses `.on('message', cb)` and
 *  `.postMessage(msg)`, same as our DuplexPort contract. */
function asDuplex(child: UtilityProcess) {
	return {
		postMessage: (m: unknown) => child.postMessage(m),
		on: (event: "message", listener: (data: unknown) => void) => void child.on(event, listener),
		off: (event: "message", listener: (data: unknown) => void) => void child.off(event, listener),
		close: () => {
			child.kill();
		},
	};
}

export type WorkersHandle = {
	broker: Broker;
	context: BrokerContext;
	storageBridge: ResilientWorker;
	/** MailTransport worker bridge — the main-process `mail` service drives
	 *  the driver RPC over it with `_shell` envelopes (renderer envelopes to
	 *  the broker-registered `mailbox` service are rejected in the worker). */
	mailboxBridge: ResilientWorker;
	/** Readable-extraction worker (Net-2b). Not a broker service — internal,
	 *  called by the network `readable` service (Net-2c), so it's exposed as a
	 *  queue-bounded handle rather than registered for app dispatch. */
	extraction: ExtractionWorkerHandle;
	/** Register a callback fired after the storage worker respawns, so the
	 *  caller can re-bind the active vault (`setVault`) to the fresh process —
	 *  without it a respawned storage worker has no vault and every call fails
	 *  "database connection is not open". The ydoc worker takes `vaultPath`
	 *  per-call (pinned to the active vault by its gate), so it self-heals and
	 *  needs no hook. */
	setStorageRespawnHook: (cb: () => void) => void;
	dispose: () => void;
};

function logWorkerExit(name: WorkerName, code: number, willRespawn: boolean): void {
	// stdout / stderr may already be torn down during shutdown — guard against
	// EPIPE so the warn doesn't crash the quit sequence.
	try {
		console.warn(
			`[brainstorm] ${name} worker exited with code ${code}${willRespawn ? "; respawning" : ""}`,
		);
	} catch {
		// best-effort log; ignore failures.
	}
}

/** Tee a worker's piped stdio to the parent terminal (preserving the old
 *  `stdio: "inherit"` developer experience) AND capture stderr into the
 *  diagnostics error log. Workers run in their own process, so their console
 *  output never reaches the main-process log sink otherwise — which is why a
 *  worker crash used to leave only "exited with code N" with no stack. */
function pipeWorkerOutput(name: WorkerName, child: UtilityProcess): void {
	child.stdout?.on("data", (chunk: Buffer) => {
		try {
			process.stdout.write(chunk);
		} catch {
			// stdout may be torn down during shutdown — ignore EPIPE.
		}
	});
	// Buffer partial lines: a single log line can arrive split across two data
	// chunks, so emitting per-chunk would fragment it into truncated entries.
	// `inError` carries the level across a stack trace's indented continuation
	// frames, which don't repeat the structured prefix.
	let stderrBuf = "";
	let inError = false;
	const emitStderrLine = (line: string): void => {
		if (line.length === 0) return;
		// Only the worker-runtime process guards emit the structured
		// `[brainstorm:worker:<name>] <kind>: …` prefix for real faults; any
		// other stderr (a worker `console.warn`, library chatter) is diagnostic,
		// not an error, and must not pollute the error-level log the triage step
		// treats as signal. Indented frames inherit the preceding line's level.
		if (line.includes("[brainstorm:worker:")) inError = true;
		else if (!/^\s/.test(line)) inError = false;
		logDiagnostic(inError ? LogLevel.Error : LogLevel.Warn, `worker:${name}`, line);
	};
	child.stderr?.on("data", (chunk: Buffer) => {
		try {
			process.stderr.write(chunk);
		} catch {
			// ignore EPIPE during shutdown.
		}
		stderrBuf += chunk.toString("utf8");
		let nl = stderrBuf.indexOf("\n");
		while (nl !== -1) {
			emitStderrLine(stderrBuf.slice(0, nl).trimEnd());
			stderrBuf = stderrBuf.slice(nl + 1);
			nl = stderrBuf.indexOf("\n");
		}
	});
	// Flush a trailing line with no terminating newline when the stream ends
	// (a crash can exit mid-line) so the last diagnostic isn't dropped.
	child.stderr?.on("close", () => emitStderrLine(stderrBuf.trimEnd()));
}

function spawnWorker(mainDir: string, name: WorkerName, onRespawn?: () => void): ResilientWorker {
	return createResilientWorker({
		spawn: () => {
			const child: UtilityProcess = utilityProcess.fork(workerPath(mainDir, name), [], {
				serviceName: `brainstorm-${name}`,
				// Pipe (not inherit) so the worker's stderr — including the
				// process-guard stack traces — is captured to the error log.
				stdio: ["ignore", "pipe", "pipe"],
			});
			pipeWorkerOutput(name, child);
			return {
				port: asDuplex(child),
				onExit: (listener) => void child.on("exit", (code) => listener(code ?? 0)),
				kill: () => void child.kill(),
			};
		},
		isAppReady: () => app.isReady(),
		...(onRespawn ? { onRespawn } : {}),
		onExitLog: (code, willRespawn) => logWorkerExit(name, code, willRespawn),
		onGiveUp: (count, windowMs) => {
			try {
				console.error(
					`[brainstorm] ${name} worker crashed ${count}x in ${Math.round(windowMs / 1000)}s; giving up — its calls now fail fast as Unavailable until restart`,
				);
			} catch {
				// best-effort log.
			}
		},
	});
}

function makeBridgeHandler(worker: ResilientWorker) {
	return async (envelope: Envelope): Promise<unknown> => {
		const reply: EnvelopeReply = await worker.send(envelope);
		if (reply.ok) return reply.value;
		const err = new Error(reply.error.message);
		err.name = reply.error.kind;
		throw err;
	};
}

export function startWorkers(mainDir: string): WorkersHandle {
	// The storage worker is stateful (bound to a vault via `setVault`), so a
	// respawn must re-bind. index.ts owns the active session, so it registers
	// the rebind here; until it does, the hook is a no-op.
	let storageRespawnHook: (() => void) | null = null;
	const storage = spawnWorker(mainDir, "storage", () => storageRespawnHook?.());
	const ydoc = spawnWorker(mainDir, "ydoc");
	const extraction = spawnWorker(mainDir, "extraction");
	const mailbox = spawnWorker(mainDir, "mailbox");

	const context = new BrokerContext();
	const broker = new Broker({
		services: new Map(),
		verifyAppIdentity: context.verifyAppIdentity,
		checkCapability: context.checkCapability,
		onDenied: context.onDenied,
	});
	// The handlers call `worker.send`, which always targets the worker's
	// CURRENT bridge — so a respawn transparently re-points broker dispatch
	// at the fresh process with no re-registration.
	broker.registerService("storage", makeBridgeHandler(storage));
	// Shell-internal only (SH-ydoc-gate): the worker authorises nothing and
	// takes `vaultPath` per call, so apps are refused and the path is pinned
	// to the active vault.
	broker.registerService(
		"ydoc",
		gateYDocService(makeBridgeHandler(ydoc), () => getActiveVaultSession()?.vaultPath ?? null),
	);
	// The MailTransport worker (Mailbox-2). Its methods are `_shell`-gated in
	// the worker, so a renderer cannot reach the driver RPC; the main-process
	// MailSyncEngine drives it.
	broker.registerService("mailbox", makeBridgeHandler(mailbox));

	const extractionHandle = createExtractionWorkerHandle(extraction);

	const dispose = () => {
		storage.dispose();
		ydoc.dispose();
		extraction.dispose();
		mailbox.dispose();
	};

	return {
		broker,
		context,
		storageBridge: storage,
		mailboxBridge: mailbox,
		extraction: extractionHandle,
		setStorageRespawnHook: (cb) => {
			storageRespawnHook = cb;
		},
		dispose,
	};
}

// Module-level handle so IPC handlers (which run on Electron's ipcMain
// dispatch, not via startWorkers' return) can reach the active broker
// + identity registry + cache warmup.
let active: WorkersHandle | null = null;

export function setWorkersHandle(handle: WorkersHandle | null): void {
	active = handle;
}

export function getWorkersHandle(): WorkersHandle | null {
	return active;
}

/**
 * MailTransport worker — Node-based `utilityProcess` (doc 53 §shell-vs-app
 * split; OQ-MB-1 resolved: its own worker, alongside storage/ydoc/extraction).
 *
 *   Owns: the long-lived IMAP/JMAP/SMTP sockets for each connected account
 *   (OQ-MB-2: the socket lives here, inside the worker, and is never exposed
 *   to a renderer). Exposes a small driver-RPC surface — `connect` /
 *   `listFolders` / `fetch` / `submit` / `close` — that the main-process
 *   `MailSyncEngine` drives. Mail keeps syncing with the Mailbox window
 *   closed, exactly because the engine + this worker are shell-side.
 *
 * Security: every method is gated to the `_shell` sentinel app. Credentials
 * (read from Tier 2 by the main process) are injected on `connect` and never
 * cross toward a renderer; the broker never produces the `_shell` sentinel
 * for a renderer-originated envelope.
 *
 * Driver implementations: `gmail-api`, `jmap`, and `ms-graph` (M365) all ride
 * REST drivers (`gmail-driver` / `jmap-driver` / `ms-graph-driver` — stateless
 * HTTPS, no socket); `imap` rides the socket `imap-driver` (imapflow +
 * nodemailer + mailparser). All four `MailProtocol`s are now implemented;
 * live-account verification against real servers is the real-shell residue,
 * like the connector OAuth round-trip. Tests inject a `FakeMailDriver` through
 * `__setMailDriverFactory`, so the whole worker + engine spine is proven
 * in-process.
 *
 * Runs under `utilityProcess.fork`; messages are plain objects via
 * `process.parentPort`. No SQLite/Yjs/Electron-renderer types cross here.
 */

import { Buffer } from "node:buffer";
import { MailProtocol } from "@brainstorm-os/sdk-types";
import type { Envelope, EnvelopeReply } from "../../ipc/envelope";
import { makeErrorReply, makeOkReply, validateEnvelope } from "../../ipc/envelope";
import type {
	DriverCredentials,
	FetchAttachmentSpec,
	FetchSpec,
	MailDriver,
	OutboundMessage,
} from "../../main/mailbox/mail-driver";
import { installWorkerProcessGuards, wireParentPort } from "../worker-runtime";
import { makeGmailDriver } from "./gmail-driver";
import { makeImapSmtpDriver } from "./imap-driver";
import { makeJmapDriver } from "./jmap-driver";
import { makeMsGraphDriver } from "./ms-graph-driver";

type ParentPortMessage = { data: unknown };
type ParentPort = {
	on(event: "message", listener: (event: ParentPortMessage) => void): void;
	postMessage(message: unknown): void;
};
type ProcessWithParentPort = NodeJS.Process & { parentPort?: ParentPort };

const SHELL_SENTINEL_APP = "_shell" as const;
const MAILBOX_SERVICE = "mailbox" as const;

function workerError(kind: string, message: string): Error {
	const err = new Error(message);
	err.name = kind;
	return err;
}

/** Input the factory needs to build a driver for one account. */
export type DriverFactoryInput = {
	accountId: string;
	protocol: MailProtocol;
	incoming?: { host: string; port: number; tls: boolean };
	outgoing?: { host: string; port: number; tls: boolean };
	credentials: DriverCredentials;
};

export type MailDriverFactory = (input: DriverFactoryInput) => MailDriver;

/** Default: Gmail rides the REST driver; IMAP+SMTP ride the socket driver
 *  (imapflow / nodemailer); JMAP is the remaining residue. */
const defaultFactory: MailDriverFactory = (input) => {
	if (input.protocol === MailProtocol.GmailApi) {
		return makeGmailDriver({ credentials: input.credentials });
	}
	if (input.protocol === MailProtocol.Imap) {
		if (!input.incoming || !input.outgoing) {
			throw workerError(
				"Invalid",
				"imap account requires incoming (IMAP) + outgoing (SMTP) host config",
			);
		}
		return makeImapSmtpDriver({
			incoming: input.incoming,
			outgoing: input.outgoing,
			credentials: input.credentials,
		});
	}
	if (input.protocol === MailProtocol.Jmap) {
		if (!input.incoming) {
			throw workerError("Invalid", "jmap account requires an incoming host (the JMAP server)");
		}
		return makeJmapDriver({
			sessionUrl: jmapSessionUrl(input.incoming.host, input.incoming.port),
			credentials: input.credentials,
		});
	}
	if (input.protocol === MailProtocol.MsGraph) {
		return makeMsGraphDriver({ credentials: input.credentials });
	}
	throw workerError("Invalid", `unknown mail protocol "${input.protocol}"`);
};

/** RFC 8620 §2.2 autodiscovery: the well-known session resource for a JMAP
 *  server host. `.well-known/jmap` 30x-redirects to the real session URL,
 *  which `fetch` follows. Port 443 is implied and omitted. */
function jmapSessionUrl(host: string, port: number): string {
	const authority = port === 443 ? host : `${host}:${port}`;
	return `https://${authority}/.well-known/jmap`;
}

let factory: MailDriverFactory = defaultFactory;
const drivers = new Map<string, MailDriver>();

/** Test seam: swap the driver factory (e.g. to a `FakeMailDriver`). */
export function __setMailDriverFactory(next: MailDriverFactory): void {
	factory = next;
}

/** Test seam: drop all drivers + restore the default factory. */
export async function __resetMailboxWorker(): Promise<void> {
	for (const d of drivers.values()) await d.close().catch(() => {});
	drivers.clear();
	factory = defaultFactory;
}

function requireShell(envelope: Envelope): void {
	if (envelope.app !== SHELL_SENTINEL_APP) {
		throw workerError("Invalid", `mailbox.${envelope.method} is reserved for the main process`);
	}
}

function requireDriver(accountId: string): MailDriver {
	const driver = drivers.get(accountId);
	if (!driver) throw workerError("Unavailable", `no connected account "${accountId}"`);
	return driver;
}

type Handler = (envelope: Envelope) => Promise<unknown> | unknown;

const handlers: Record<string, Handler> = {
	ping: (envelope) => ({ pong: envelope.args[0] ?? null }),

	connect: (envelope) => {
		requireShell(envelope);
		const input = envelope.args[0] as DriverFactoryInput | undefined;
		if (!input || typeof input.accountId !== "string" || input.accountId.length === 0) {
			throw workerError("Invalid", "mailbox.connect requires { accountId, protocol, credentials }");
		}
		const previous = drivers.get(input.accountId);
		if (previous) void previous.close().catch(() => {});
		drivers.set(input.accountId, factory(input));
		return { connected: true };
	},

	listFolders: async (envelope) => {
		requireShell(envelope);
		const { accountId } = envelope.args[0] as { accountId: string };
		return { folders: await requireDriver(accountId).listFolders() };
	},

	fetch: async (envelope) => {
		requireShell(envelope);
		const { accountId, spec } = envelope.args[0] as { accountId: string; spec: FetchSpec };
		return requireDriver(accountId).fetch(spec);
	},

	submit: async (envelope) => {
		requireShell(envelope);
		const { accountId, message } = envelope.args[0] as {
			accountId: string;
			message: OutboundMessage;
		};
		return requireDriver(accountId).submit(message);
	},

	fetchAttachment: async (envelope) => {
		requireShell(envelope);
		const { accountId, spec } = envelope.args[0] as {
			accountId: string;
			spec: FetchAttachmentSpec;
		};
		const driver = requireDriver(accountId);
		if (!driver.fetchAttachment) {
			throw workerError("Unavailable", "this account's protocol cannot fetch attachments");
		}
		const result = await driver.fetchAttachment(spec);
		return {
			bytesBase64: Buffer.from(result.bytes).toString("base64"),
			...(result.mimeType !== undefined ? { mimeType: result.mimeType } : {}),
		};
	},

	close: async (envelope) => {
		requireShell(envelope);
		const { accountId } = envelope.args[0] as { accountId: string };
		const driver = drivers.get(accountId);
		if (driver) {
			await driver.close().catch(() => {});
			drivers.delete(accountId);
		}
		return { closed: true };
	},
};

export async function handleMailboxEnvelope(raw: unknown): Promise<EnvelopeReply> {
	const validation = validateEnvelope(raw);
	if (!validation.ok) {
		return makeErrorReply(messageIdOrFallback(raw), {
			kind: "Invalid",
			message: validation.reason,
		});
	}
	const envelope = validation.envelope;
	if (envelope.service !== MAILBOX_SERVICE) {
		return makeErrorReply(envelope.msg, {
			kind: "Invalid",
			message: `wrong service routed to mailbox worker: ${envelope.service}`,
		});
	}
	const handler = handlers[envelope.method];
	if (!handler) {
		return makeErrorReply(envelope.msg, {
			kind: "Unavailable",
			message: `mailbox method not implemented: ${envelope.method}`,
			method: envelope.method,
		});
	}
	try {
		const value = await handler(envelope);
		return makeOkReply(envelope.msg, value);
	} catch (error) {
		return makeErrorReply(envelope.msg, errorPayload(error));
	}
}

function messageIdOrFallback(raw: unknown): string {
	if (raw && typeof raw === "object") {
		const m = (raw as { msg?: unknown }).msg;
		if (typeof m === "string" && m.length > 0 && m.length <= 128) return m;
	}
	return "unknown";
}

function errorPayload(error: unknown): { kind: string; message: string } {
	if (error instanceof Error) {
		return { kind: error.name || "Error", message: error.message };
	}
	return { kind: "Error", message: String(error) };
}

export function handleParentPortMessage(event: ParentPortMessage): Promise<EnvelopeReply> {
	return handleMailboxEnvelope(event.data);
}

// In Vitest there is no parentPort, so handlers are exercised directly via
// `handleMailboxEnvelope`; the wiring below is skipped (gated on presence).
installWorkerProcessGuards("mailbox");
wireParentPort("mailbox", handleParentPortMessage, (process as ProcessWithParentPort).parentPort);

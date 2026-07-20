/**
 * Main-process adapter from the `MailDriver` interface to the MailTransport
 * worker's driver RPC (`workers/mailbox/`). The worker owns the actual
 * driver (sockets / HTTP sessions never leave it); the `MailSyncEngine`
 * drives this proxy exactly as it would an in-process driver, so the engine
 * stays transport-location-agnostic. All envelopes carry the `_shell`
 * sentinel — the worker rejects anything else, so a renderer can never
 * reach the driver RPC.
 */

import { Buffer } from "node:buffer";
import type { MailProtocol } from "@brainstorm/sdk-types";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope, type EnvelopeReply } from "../../ipc/envelope";
import type {
	DriverCredentials,
	FetchAttachmentSpec,
	FetchResult,
	FetchSpec,
	MailDriver,
	OutboundMessage,
	RawFolder,
	SubmitResult,
} from "./mail-driver";

/** Attachment bytes travel base64 in the JSON envelope (see `fetchAttachment`). */
export type WireAttachmentResult = { bytesBase64: string; mimeType?: string };

/** The slice of `ResilientWorker` this adapter needs (injectable for tests). */
export type MailboxWorkerBridge = {
	send(envelope: Envelope, options?: { timeoutMs?: number }): Promise<EnvelopeReply>;
};

const SHELL_APP = "_shell";
const MAILBOX_SERVICE = "mailbox";
/** One fetch page can be hundreds of per-message provider calls (Gmail has
 *  no bulk body endpoint), so the fetch leg gets a far longer budget than
 *  the control calls. */
const FETCH_TIMEOUT_MS = 180_000;
const CALL_TIMEOUT_MS = 30_000;

export type WorkerMailTransport = {
	/** Inject credentials + build the worker-side driver for one account. */
	connect(input: {
		accountId: string;
		protocol: MailProtocol;
		credentials: DriverCredentials;
	}): Promise<void>;
	/** A `MailDriver` proxy speaking the worker RPC for one account.
	 *  `close()` drops the worker-side driver (and the injected secret). */
	driverFor(accountId: string, protocol: MailProtocol): MailDriver;
};

export function createWorkerMailTransport(bridge: MailboxWorkerBridge): WorkerMailTransport {
	let seq = 0;
	const call = async (method: string, arg: unknown, timeoutMs: number): Promise<unknown> => {
		seq += 1;
		const envelope: Envelope = {
			v: ENVELOPE_PROTOCOL_VERSION,
			msg: `mail-${seq}`,
			app: SHELL_APP,
			service: MAILBOX_SERVICE,
			method,
			args: [arg],
			caps: [],
		};
		const reply = await bridge.send(envelope, { timeoutMs });
		if (reply.ok) return reply.value;
		const error = new Error(reply.error.message);
		error.name = reply.error.kind;
		throw error;
	};

	return {
		connect: async (input) => {
			await call("connect", input, CALL_TIMEOUT_MS);
		},
		driverFor: (accountId, protocol) => ({
			protocol,
			listFolders: async () =>
				((await call("listFolders", { accountId }, CALL_TIMEOUT_MS)) as { folders: RawFolder[] })
					.folders,
			fetch: (spec: FetchSpec) =>
				call("fetch", { accountId, spec }, FETCH_TIMEOUT_MS) as Promise<FetchResult>,
			submit: (message: OutboundMessage) =>
				call("submit", { accountId, message }, CALL_TIMEOUT_MS) as Promise<SubmitResult>,
			fetchAttachment: async (spec: FetchAttachmentSpec) => {
				const reply = (await call(
					"fetchAttachment",
					{ accountId, spec },
					FETCH_TIMEOUT_MS,
				)) as WireAttachmentResult;
				// Bytes cross the worker boundary base64-encoded: structured clone
				// would ship a Uint8Array, but the envelope is JSON on the wire.
				return {
					bytes: new Uint8Array(Buffer.from(reply.bytesBase64, "base64")),
					...(reply.mimeType !== undefined ? { mimeType: reply.mimeType } : {}),
				};
			},
			close: async () => {
				await call("close", { accountId }, CALL_TIMEOUT_MS);
			},
		}),
	};
}

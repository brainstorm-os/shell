/**
 * In-memory `MailDriver` for dev + tests. The real IMAP/SMTP/JMAP drivers
 * (long-lived TLS sockets) are the real-shell residue (OQ-MB-2); this driver
 * lets the entire sync engine + worker + projection be proven in-process,
 * exactly as the connector framework proves its spine with `fakePorts`.
 *
 * It models a server: folders, messages keyed by `Message-ID`, and a Sent
 * folder that `submit` appends to (so the idempotent-send path is testable).
 */

import { type MailProtocol, MailProtocol as Protocol } from "@brainstorm/sdk-types";
import type {
	FetchResult,
	FetchSpec,
	MailDriver,
	OutboundMessage,
	RawFolder,
	RawMessage,
	SubmitResult,
} from "./mail-driver";
import { FetchWalk } from "./mail-driver";

export type FakeServerState = {
	folders: RawFolder[];
	/** folderPath → messages in that folder. */
	messages: Record<string, RawMessage[]>;
};

export class FakeMailDriver implements MailDriver {
	readonly protocol: MailProtocol = Protocol.Imap;
	private closed = false;
	private clock: number;

	constructor(
		private readonly state: FakeServerState,
		now = 1_717_000_000_000,
	) {
		this.clock = now;
	}

	async listFolders(): Promise<RawFolder[]> {
		this.assertOpen();
		return this.state.folders.map((f) => ({ ...f }));
	}

	async fetch(spec: FetchSpec): Promise<FetchResult> {
		this.assertOpen();
		const all = this.state.messages[spec.folderPath] ?? [];
		if (spec.walk === FetchWalk.Backfill) {
			// Older-walk model: an offset cursor over the newest-first ordering;
			// `sinceMs` ignored (the walk deliberately exceeds the window).
			const sorted = [...all].sort((a, b) => b.receivedAt - a.receivedAt);
			const offset = spec.cursor !== undefined ? Number(spec.cursor) || 0 : 0;
			const page = sorted.slice(offset, offset + spec.limit).map((m) => ({ ...m }));
			const nextOffset = offset + page.length;
			return {
				messages: page,
				...(nextOffset < sorted.length ? { nextCursor: String(nextOffset) } : {}),
			};
		}
		const filtered = all
			.filter((m) => (spec.sinceMs === undefined ? true : m.receivedAt >= spec.sinceMs))
			.sort((a, b) => b.receivedAt - a.receivedAt)
			.slice(0, spec.limit)
			.map((m) => ({ ...m }));
		return { messages: filtered };
	}

	async submit(message: OutboundMessage): Promise<SubmitResult> {
		this.assertOpen();
		this.clock += 1;
		const messageId = `<sent-${message.submissionId}@fake>`;
		const sent: RawMessage = {
			messageId,
			from: message.from,
			...(message.to.length > 0 ? { to: message.to.join(", ") } : {}),
			...(message.cc && message.cc.length > 0 ? { cc: message.cc.join(", ") } : {}),
			...(message.subject !== undefined ? { subject: message.subject } : {}),
			...(message.bodyText !== undefined ? { bodyText: message.bodyText } : {}),
			...(message.bodyHtml !== undefined ? { bodyHtml: message.bodyHtml } : {}),
			...(message.inReplyTo !== undefined ? { inReplyTo: message.inReplyTo } : {}),
			...(message.references !== undefined ? { references: message.references } : {}),
			receivedAt: this.clock,
			flags: [],
			folderPath: this.sentFolderPath(),
		};
		const path = this.sentFolderPath();
		const folder = this.state.messages[path] ?? [];
		folder.push(sent);
		this.state.messages[path] = folder;
		return { messageId, receivedAt: this.clock };
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	private sentFolderPath(): string {
		const sent = this.state.folders.find((f) => /sent/i.test(f.path));
		return sent?.path ?? "Sent";
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("fake-mail-driver: used after close()");
	}
}

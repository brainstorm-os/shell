/**
 * Composer seeds + the `send` intent payload (Mailbox-4). Pure: the
 * component layer passes localized strings in (quote header, subject
 * prefixes), so reply/forward seeding and recipient parsing are unit-tested
 * without React. Sending is an intent, not a Mailbox API (doc 53 §Sending):
 * the composer stamps a `submissionId` once per draft and dispatches
 * `send` — the shell-side MailTransport dedupes on it, so a retry after a
 * flaky dispatch can never double-send.
 */

import {
	type MailAddress,
	SendIntentVerb,
	formatMailAddress,
	parseAddressList,
} from "@brainstorm/sdk-types";
import type { MessageView } from "../types/mail-view";

export { SendIntentVerb };

/** Editable composer state. Recipient fields stay free-text (comma
 *  separated) until send-time parsing. */
export type ComposeSeed = {
	accountRef?: string;
	to: string;
	cc: string;
	subject: string;
	body: string;
	inReplyTo?: string;
	references?: string[];
	submissionId: string;
};

/** Client-stamped idempotency key — generated once when the composer
 *  opens, constant across retries of the same draft. */
export function newSubmissionId(): string {
	const rand = Math.random().toString(36).slice(2, 10);
	return `sub-${Date.now().toString(36)}-${rand}`;
}

export function emptySeed(accountRef?: string): ComposeSeed {
	return {
		...(accountRef !== undefined ? { accountRef } : {}),
		to: "",
		cc: "",
		subject: "",
		body: "",
		submissionId: newSubmissionId(),
	};
}

function addressLine(addresses: readonly MailAddress[]): string {
	return addresses.map((a) => formatMailAddress(a)).join(", ");
}

function prefixedSubject(subject: string, prefix: string): string {
	const trimmed = subject.trim();
	if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return trimmed;
	return `${prefix} ${trimmed}`.trim();
}

/** `> `-quote the original plain-text body under a localized header line. */
export function quotedBody(original: string, quoteHeader: string): string {
	const quoted = original
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	return `\n\n${quoteHeader}\n${quoted}`;
}

const REPLY_PREFIX = "Re:";
const FORWARD_PREFIX = "Fwd:";

export function replySeed(message: MessageView, quoteHeader: string): ComposeSeed {
	return {
		accountRef: message.accountRef,
		to: addressLine(message.from),
		cc: "",
		subject: prefixedSubject(message.subject, REPLY_PREFIX),
		body: quotedBody(message.bodyText, quoteHeader),
		inReplyTo: message.messageId,
		references: [message.messageId],
		submissionId: newSubmissionId(),
	};
}

export function forwardSeed(message: MessageView, quoteHeader: string): ComposeSeed {
	return {
		accountRef: message.accountRef,
		to: "",
		cc: "",
		subject: prefixedSubject(message.subject, FORWARD_PREFIX),
		body: quotedBody(message.bodyText, quoteHeader),
		submissionId: newSubmissionId(),
	};
}

/** Seed from an inbound `compose` / `reply` / `forward` intent payload —
 *  another app (or the Agent) dispatched against Mailbox. `findMessage`
 *  resolves the payload's `entityId` for reply/forward quoting. */
export function seedFromIntentPayload(
	verb: string,
	payload: Record<string, unknown>,
	findMessage: (entityId: string) => MessageView | null,
	quoteHeader: string,
): ComposeSeed {
	const entityId = typeof payload.entityId === "string" ? payload.entityId : null;
	const original = entityId ? findMessage(entityId) : null;
	if (original && verb === SendIntentVerb.Reply) return replySeed(original, quoteHeader);
	if (original && verb === SendIntentVerb.Forward) return forwardSeed(original, quoteHeader);
	const seed = emptySeed();
	if (typeof payload.accountRef === "string" && payload.accountRef.length > 0) {
		seed.accountRef = payload.accountRef;
	}
	if (typeof payload.to === "string") seed.to = payload.to;
	else if (Array.isArray(payload.to)) seed.to = payload.to.filter(isString).join(", ");
	if (typeof payload.subject === "string") seed.subject = payload.subject;
	if (typeof payload.body === "string") seed.body = payload.body;
	return seed;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

/** Free-text recipients → normalized header-form addresses. Invalid chunks
 *  are dropped (the dialog validates non-emptiness before send). */
export function parseRecipients(input: string): string[] {
	return parseAddressList(input).map((a) => formatMailAddress(a));
}

/** The `send` intent payload (validated again shell-side by
 *  `validateMailSendInput`). Null when required fields are missing. */
export function sendPayloadFromSeed(
	seed: ComposeSeed,
	accountRef: string,
	bodyHtml?: string,
): Record<string, unknown> | null {
	const to = parseRecipients(seed.to);
	if (to.length === 0 || accountRef.length === 0) return null;
	const cc = parseRecipients(seed.cc);
	const subject = seed.subject.trim();
	return {
		accountRef,
		to,
		...(cc.length > 0 ? { cc } : {}),
		...(subject.length > 0 ? { subject } : {}),
		bodyText: seed.body,
		...(bodyHtml !== undefined && bodyHtml.length > 0 ? { bodyHtml } : {}),
		submissionId: seed.submissionId,
		...(seed.inReplyTo !== undefined ? { inReplyTo: seed.inReplyTo } : {}),
		...(seed.references !== undefined ? { references: seed.references } : {}),
	};
}

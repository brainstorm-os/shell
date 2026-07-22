/**
 * Shared outbound-MIME builder for the REST mail drivers (Gmail, MS Graph).
 * Both send by base64-ing a raw RFC 822 message and POSTing it (Gmail
 * `messages/send {raw}`, Graph `sendMail` with a MIME body), so building the
 * same MIME in one place keeps the self-stamped `Message-ID` (idempotency),
 * RFC 2047 header encoding, and multipart/alternative structure identical
 * across providers. IMAP (nodemailer) and JMAP (`Email/set`) submit through
 * their own protocol paths, not this.
 */

import { Buffer } from "node:buffer";
import type { OutboundMessage } from "../../main/mailbox/mail-driver";
import { sanitizeIdToken } from "./driver-common";

export const MIME_TEXT_PLAIN = "text/plain";
export const MIME_TEXT_HTML = "text/html";

function isAscii(value: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range check is the point
	return /^[\x00-\x7F]*$/.test(value);
}

/** RFC 2047 encoded-word for a non-ASCII header value. */
function encodeHeaderValue(value: string): string {
	if (isAscii(value)) return value;
	return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Base64 body chunked to 76-char lines per RFC 2045 §6.8. */
function encodeBodyBase64(value: string): string {
	const b64 = Buffer.from(value, "utf8").toString("base64");
	return b64.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function bodyPartLines(mimeType: string, content: string): string[] {
	return [
		`Content-Type: ${mimeType}; charset=utf-8`,
		"Content-Transfer-Encoding: base64",
		"",
		encodeBodyBase64(content),
	];
}

/** A complete RFC 822 message string with a self-stamped `Message-ID`. Callers
 *  base64/base64url it for their provider's raw-send endpoint. */
export function buildMimeMessage(
	message: OutboundMessage,
	messageId: string,
	nowMs: number,
): string {
	const lines: string[] = [
		`Message-ID: ${messageId}`,
		`Date: ${new Date(nowMs).toUTCString()}`,
		`From: ${message.from}`,
		`To: ${message.to.join(", ")}`,
	];
	if (message.cc && message.cc.length > 0) lines.push(`Cc: ${message.cc.join(", ")}`);
	if (message.subject !== undefined) {
		lines.push(`Subject: ${encodeHeaderValue(message.subject)}`);
	}
	if (message.inReplyTo !== undefined) lines.push(`In-Reply-To: ${message.inReplyTo}`);
	if (message.references && message.references.length > 0) {
		lines.push(`References: ${message.references.join(" ")}`);
	}
	lines.push("MIME-Version: 1.0");

	const hasText = message.bodyText !== undefined;
	const hasHtml = message.bodyHtml !== undefined;
	if (hasText && hasHtml) {
		const boundary = `bs-${sanitizeIdToken(message.submissionId)}`;
		lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, "");
		lines.push(`--${boundary}`);
		lines.push(...bodyPartLines(MIME_TEXT_PLAIN, message.bodyText ?? ""));
		lines.push(`--${boundary}`);
		lines.push(...bodyPartLines(MIME_TEXT_HTML, message.bodyHtml ?? ""));
		lines.push(`--${boundary}--`);
	} else if (hasHtml) {
		lines.push(...bodyPartLines(MIME_TEXT_HTML, message.bodyHtml ?? ""));
	} else {
		lines.push(...bodyPartLines(MIME_TEXT_PLAIN, message.bodyText ?? ""));
	}
	return lines.join("\r\n");
}

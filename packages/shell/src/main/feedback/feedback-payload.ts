/**
 * Feedback-1 — bug-report client payload keystone.
 *
 * Pure (no Electron, no fs, no network) — the `FeedbackService` in
 * `feedback-service.ts` composes this keystone with the network broker
 * and the persistent opt-in store. Everything UI-bound consumes only the
 * types + enums + helpers exported here.
 *
 * The redactor is correctness-critical: every code path that lands a
 * user-typed body / log excerpt on the wire MUST flow through
 * `redactPayload`. The redaction rules are positioned in
 *
 * §Posture rules ("data minimisation") and
 *
 * §The shell's own network traffic ("Feedback — Opt-in path").
 *
 * Rules enforced here:
 *
 *   - Anonymous sensitivity strips `contactEmail` and every email-shaped
 *     token from `body` / `recentLogExcerpt`. IdentityVoluntary keeps the
 *     user-typed `contactEmail` (deliberate) but still strips email-shaped
 *     tokens from `body` / `recentLogExcerpt` that the user did NOT type
 *     into the dedicated field (e.g. a stray "ops@vendor.example" in a
 *     pasted log line).
 *   - The active vault path is rewritten to the literal `<vault>` so a
 *     pasted error message containing `/Users/<n>/MyVault/...` becomes
 *     `<vault>/...`. Both POSIX and `~`-expanded forms are caught.
 *   - Any unrelated POSIX home prefix (`/Users/<name>/` or
 *     `/home/<name>/`) collapses to `<home>/`. Windows `C:\Users\<name>\`
 *     handled symmetrically.
 *   - Brainstorm credential-store key patterns (`proxy.<host>:<port>`,
 *     `noble.*`, `kr:*`) collapse to `<credential>` — they're opaque
 *     lookup keys to us but shouldn't appear in admin-panel inboxes.
 *   - `recentLogExcerpt` truncates to the last 64 KiB. Logs longer than
 *     that drop the head; the tail is what staff want for triage.
 *   - When `includeRecentLog === false`, `recentLogExcerpt` is dropped
 *     entirely (defence-in-depth — even if the caller populated the
 *     field, the redactor refuses it).
 *
 * `validatePayload` runs strict shape + length checks; on failure it
 * returns a typed `FeedbackValidationError` the dialog UI maps to a
 * t()-keyed surface message.
 *
 * `newRequestId(now, random)` mints a ULID-shaped 26-char id; the
 * defaults plug in `Date.now` + `Math.random` but the args make
 * deterministic test ids trivial.
 */

/** Kind of feedback report per [[feedback_enums_not_string_constants]].
 *  String values are the on-the-wire form (stable across persistence + any
 *  future export path); enum keys are the in-code reference. */
export enum FeedbackKind {
	Bug = "bug",
	Idea = "idea",
	Question = "question",
	Other = "other",
}

/** Identification posture per doc-48 §Identification posture.
 *  `Anonymous` is the default — no email, no log paths. The user has to
 *  flip to `IdentityVoluntary` to send their email along with the report. */
export enum FeedbackSensitivity {
	Anonymous = "anonymous",
	IdentityVoluntary = "identity-voluntary",
}

/** Validator error variants surfaced via `validatePayload`. The dialog
 *  UI maps each to a t()-keyed inline error; the wire never serialises
 *  these (they're rejection reasons, not part of the payload). */
export enum FeedbackValidationError {
	MissingKind = "missing-kind",
	InvalidKind = "invalid-kind",
	MissingTitle = "missing-title",
	TitleEmpty = "title-empty",
	TitleTooLong = "title-too-long",
	MissingBody = "missing-body",
	BodyEmpty = "body-empty",
	BodyTooLong = "body-too-long",
	MissingSensitivity = "missing-sensitivity",
	InvalidSensitivity = "invalid-sensitivity",
	InvalidEmail = "invalid-email",
	MissingClientVersion = "missing-client-version",
	MissingPlatform = "missing-platform",
	MissingRequestId = "missing-request-id",
	MalformedShape = "malformed-shape",
}

/** Strict bounds enforced by `validatePayload`. Mirrors doc-48 §Feedback
 *  ("free-form text area") — the cap is generous enough for a thorough
 *  bug narrative but tight enough that a paste of a 1 MB log lands in
 *  `recentLogExcerpt` instead of `body`. */
export const TITLE_MIN_LENGTH = 1;
export const TITLE_MAX_LENGTH = 200;
export const BODY_MIN_LENGTH = 1;
export const BODY_MAX_LENGTH = 10_000;
export const RECENT_LOG_MAX_BYTES = 64 * 1024;

export type FeedbackPayload = {
	readonly kind: FeedbackKind;
	readonly title: string;
	readonly body: string;
	readonly sensitivity: FeedbackSensitivity;
	readonly contactEmail?: string;
	readonly includeRecentLog: boolean;
	readonly recentLogExcerpt?: string;
	readonly clientVersion: string;
	readonly clientPlatform: string;
	readonly submittedAt: number;
	readonly requestId: string;
};

export type FeedbackPayloadValidationResult =
	| { readonly ok: true; readonly payload: FeedbackPayload }
	| {
			readonly ok: false;
			readonly error: FeedbackValidationError;
			readonly detail: string;
	  };

/** Loose-shape RFC-5322 compromise — we don't actually need to bounce a
 *  message, just refuse obvious typos. Matches the same pattern used in
 *  HTML `<input type="email">` validation: a `local@domain.tld` shape
 *  with at least one dot in the domain. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Brainstorm credential-store key shapes per doc-29.
 *  `proxy.<host>:<port>` — Net-1d/e per-endpoint key,
 *  `noble.*` — noble-keyed credential,
 *  `kr:*` — keyring fallback key.
 *  The matcher errs on the side of false positives: a stray `kr:foo` in
 *  a body should not leak. */
const CREDENTIAL_KEY_PATTERN =
	/\b(?:proxy\.[a-z0-9.-]+(?::\d{1,5})?|noble\.[a-z0-9._-]+|kr:[a-zA-Z0-9._-]+)\b/g;

/** POSIX `/Users/<name>/` (macOS) + `/home/<name>/` (Linux) prefix. */
const POSIX_HOME_PATTERN = /\/(?:Users|home)\/[^/\s]+\//g;

/** Windows `C:\Users\<name>\` prefix — case-insensitive on the drive
 *  letter + `Users`. Stays defensive even though Brainstorm doesn't ship
 *  with Windows builds yet (the redaction tests assert it works). */
const WINDOWS_HOME_PATTERN = /\b[A-Z]:\\Users\\[^\\\s]+\\/gi;

/** Email-shaped token sniffer for body / log scrubbing. The pattern is
 *  intentionally aggressive — false positives strip too much (still
 *  better than leaking a customer's email in a paste) but false
 *  negatives let an email survive. */
const EMAIL_IN_TEXT_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export type RedactionOptions = {
	/** Vault path of the active session, redacted to `<vault>`. Both
	 *  POSIX (`/Users/n/Vault`) and `~`-expanded (`~/Vault`) forms are
	 *  caught; trailing slashes are normalised so a body of
	 *  `<vault>/Notes/foo.md` always collapses uniformly. */
	readonly vaultPath: string;
};

/** Strip every secret-shaped token from a `FeedbackPayload` and return a
 *  fresh payload. Pure — does not mutate the input. */
export function redactPayload(
	payload: FeedbackPayload,
	options: RedactionOptions,
): FeedbackPayload {
	const vaultPath = options.vaultPath;

	let body = redactText(payload.body, vaultPath);
	if (payload.sensitivity === FeedbackSensitivity.Anonymous) {
		body = scrubEmails(body);
	} else {
		body = scrubEmailsExcept(body, payload.contactEmail);
	}

	let recentLogExcerpt: string | undefined;
	if (payload.includeRecentLog && typeof payload.recentLogExcerpt === "string") {
		let log = redactText(payload.recentLogExcerpt, vaultPath);
		log = scrubEmails(log);
		recentLogExcerpt = truncateTail(log, RECENT_LOG_MAX_BYTES);
	}

	let contactEmail: string | undefined;
	if (payload.sensitivity === FeedbackSensitivity.IdentityVoluntary) {
		contactEmail = payload.contactEmail;
	}

	const next: FeedbackPayload = {
		kind: payload.kind,
		title: payload.title,
		body,
		sensitivity: payload.sensitivity,
		includeRecentLog: payload.includeRecentLog,
		clientVersion: payload.clientVersion,
		clientPlatform: payload.clientPlatform,
		submittedAt: payload.submittedAt,
		requestId: payload.requestId,
		...(contactEmail !== undefined ? { contactEmail } : {}),
		...(recentLogExcerpt !== undefined ? { recentLogExcerpt } : {}),
	};
	return next;
}

/** Pure path-substitution chain applied to body + log: vault prefix → home
 *  prefix → credential keys. Order matters — vault path may sit under the
 *  home prefix, so vault collapse runs first. */
function redactText(input: string, vaultPath: string): string {
	let out = input;
	const cleaned = vaultPath.replace(/[/\\]+$/, "");
	if (cleaned.length > 0) {
		out = replaceAll(out, cleaned, "<vault>");
		const homeExpanded = expandHomePrefix(cleaned);
		if (homeExpanded !== null && homeExpanded !== cleaned) {
			out = replaceAll(out, homeExpanded, "<vault>");
		}
		const tildeForm = collapseToTilde(cleaned);
		if (tildeForm !== null && tildeForm !== cleaned) {
			out = replaceAll(out, tildeForm, "<vault>");
		}
	}
	out = out.replace(POSIX_HOME_PATTERN, "<home>/");
	out = out.replace(WINDOWS_HOME_PATTERN, "<home>\\");
	out = out.replace(CREDENTIAL_KEY_PATTERN, "<credential>");
	return out;
}

/** Replace every literal occurrence of `needle` in `haystack`. Avoids
 *  the surprises of `String.prototype.replaceAll` regex-syntax escaping
 *  on a user-supplied path. */
function replaceAll(haystack: string, needle: string, replacement: string): string {
	if (needle.length === 0) return haystack;
	let out = "";
	let cursor = 0;
	while (cursor <= haystack.length) {
		const found = haystack.indexOf(needle, cursor);
		if (found === -1) {
			out += haystack.slice(cursor);
			break;
		}
		out += haystack.slice(cursor, found);
		out += replacement;
		cursor = found + needle.length;
	}
	return out;
}

/** Try to map a `~`-prefixed path into its absolute POSIX equivalent.
 *  Reads `HOME` / `USERPROFILE` from the ambient `process.env` if the
 *  module is running under Node; in a browser-shimmed test path the
 *  function returns `null` (no expansion possible). */
function expandHomePrefix(input: string): string | null {
	if (!input.startsWith("~/") && input !== "~") return null;
	const home = readHomeDir();
	if (!home) return null;
	if (input === "~") return home;
	return `${home}${input.slice(1)}`;
}

/** Inverse of `expandHomePrefix` — turn an absolute home-anchored path
 *  into its `~/...` form, if home is known. */
function collapseToTilde(input: string): string | null {
	const home = readHomeDir();
	if (!home || home.length === 0) return null;
	const normalisedHome = home.replace(/[/\\]+$/, "");
	if (input === normalisedHome) return "~";
	if (input.startsWith(`${normalisedHome}/`)) {
		return `~/${input.slice(normalisedHome.length + 1)}`;
	}
	if (input.startsWith(`${normalisedHome}\\`)) {
		return `~\\${input.slice(normalisedHome.length + 1)}`;
	}
	return null;
}

function readHomeDir(): string {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env;
	const home = env?.HOME ?? env?.USERPROFILE ?? "";
	return typeof home === "string" ? home : "";
}

function scrubEmails(input: string): string {
	return input.replace(EMAIL_IN_TEXT_PATTERN, "<email>");
}

/** Email scrub that preserves a single user-typed contact email so the
 *  body can reference it (e.g. "respond to me at me@example.com please"). */
function scrubEmailsExcept(input: string, preserved: string | undefined): string {
	return input.replace(EMAIL_IN_TEXT_PATTERN, (token) => {
		if (preserved && token.toLowerCase() === preserved.toLowerCase()) return token;
		return "<email>";
	});
}

/** Keep the last `maxBytes` UTF-8 bytes of `input`. Cuts on a code-unit
 *  boundary — a multi-byte rune split at the cut produces a single `…`
 *  replacement marker, not a poisoned UTF-8 sequence. */
function truncateTail(input: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(input);
	if (encoded.length <= maxBytes) return input;
	const slice = encoded.slice(encoded.length - maxBytes);
	const decoded = new TextDecoder("utf-8", { fatal: false }).decode(slice);
	return `…${decoded}`;
}

/** Strict input validation. Returns the typed result so the dialog can
 *  map errors to t-keyed messages without parsing free-text. */
export function validatePayload(input: unknown): FeedbackPayloadValidationResult {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return {
			ok: false,
			error: FeedbackValidationError.MalformedShape,
			detail: "feedback payload must be a plain object",
		};
	}
	const raw = input as Record<string, unknown>;

	if (raw.kind === undefined) {
		return {
			ok: false,
			error: FeedbackValidationError.MissingKind,
			detail: "{ kind } is required",
		};
	}
	if (!isFeedbackKind(raw.kind)) {
		return {
			ok: false,
			error: FeedbackValidationError.InvalidKind,
			detail: `unknown kind ${String(raw.kind)}`,
		};
	}

	if (raw.title === undefined) {
		return {
			ok: false,
			error: FeedbackValidationError.MissingTitle,
			detail: "{ title } is required",
		};
	}
	if (typeof raw.title !== "string") {
		return {
			ok: false,
			error: FeedbackValidationError.MissingTitle,
			detail: "{ title } must be a string",
		};
	}
	const title = raw.title;
	if (title.trim().length < TITLE_MIN_LENGTH) {
		return {
			ok: false,
			error: FeedbackValidationError.TitleEmpty,
			detail: "{ title } must contain at least one non-whitespace character",
		};
	}
	if (title.length > TITLE_MAX_LENGTH) {
		return {
			ok: false,
			error: FeedbackValidationError.TitleTooLong,
			detail: `{ title } must be ≤ ${TITLE_MAX_LENGTH} chars`,
		};
	}

	if (raw.body === undefined) {
		return {
			ok: false,
			error: FeedbackValidationError.MissingBody,
			detail: "{ body } is required",
		};
	}
	if (typeof raw.body !== "string") {
		return {
			ok: false,
			error: FeedbackValidationError.MissingBody,
			detail: "{ body } must be a string",
		};
	}
	const body = raw.body;
	if (body.trim().length < BODY_MIN_LENGTH) {
		return {
			ok: false,
			error: FeedbackValidationError.BodyEmpty,
			detail: "{ body } must contain at least one non-whitespace character",
		};
	}
	if (body.length > BODY_MAX_LENGTH) {
		return {
			ok: false,
			error: FeedbackValidationError.BodyTooLong,
			detail: `{ body } must be ≤ ${BODY_MAX_LENGTH} chars`,
		};
	}

	if (raw.sensitivity === undefined) {
		return {
			ok: false,
			error: FeedbackValidationError.MissingSensitivity,
			detail: "{ sensitivity } is required",
		};
	}
	if (!isFeedbackSensitivity(raw.sensitivity)) {
		return {
			ok: false,
			error: FeedbackValidationError.InvalidSensitivity,
			detail: `unknown sensitivity ${String(raw.sensitivity)}`,
		};
	}
	const sensitivity = raw.sensitivity;

	let contactEmail: string | undefined;
	if (sensitivity === FeedbackSensitivity.IdentityVoluntary) {
		if (raw.contactEmail !== undefined) {
			if (typeof raw.contactEmail !== "string") {
				return {
					ok: false,
					error: FeedbackValidationError.InvalidEmail,
					detail: "{ contactEmail } must be a string",
				};
			}
			const trimmed = raw.contactEmail.trim();
			if (trimmed.length > 0 && !EMAIL_PATTERN.test(trimmed)) {
				return {
					ok: false,
					error: FeedbackValidationError.InvalidEmail,
					detail: `{ contactEmail } ${trimmed} is not a valid email`,
				};
			}
			if (trimmed.length > 0) contactEmail = trimmed;
		}
	}

	if (typeof raw.includeRecentLog !== "boolean") {
		return {
			ok: false,
			error: FeedbackValidationError.MalformedShape,
			detail: "{ includeRecentLog } must be a boolean",
		};
	}
	const includeRecentLog = raw.includeRecentLog;

	let recentLogExcerpt: string | undefined;
	if (raw.recentLogExcerpt !== undefined) {
		if (typeof raw.recentLogExcerpt !== "string") {
			return {
				ok: false,
				error: FeedbackValidationError.MalformedShape,
				detail: "{ recentLogExcerpt } must be a string",
			};
		}
		recentLogExcerpt = raw.recentLogExcerpt;
	}

	if (raw.clientVersion === undefined || typeof raw.clientVersion !== "string") {
		return {
			ok: false,
			error: FeedbackValidationError.MissingClientVersion,
			detail: "{ clientVersion } is required",
		};
	}
	if (raw.clientVersion.length === 0) {
		return {
			ok: false,
			error: FeedbackValidationError.MissingClientVersion,
			detail: "{ clientVersion } must be non-empty",
		};
	}

	if (raw.clientPlatform === undefined || typeof raw.clientPlatform !== "string") {
		return {
			ok: false,
			error: FeedbackValidationError.MissingPlatform,
			detail: "{ clientPlatform } is required",
		};
	}
	if (raw.clientPlatform.length === 0) {
		return {
			ok: false,
			error: FeedbackValidationError.MissingPlatform,
			detail: "{ clientPlatform } must be non-empty",
		};
	}

	if (typeof raw.submittedAt !== "number" || !Number.isFinite(raw.submittedAt)) {
		return {
			ok: false,
			error: FeedbackValidationError.MalformedShape,
			detail: "{ submittedAt } must be a finite number",
		};
	}

	if (raw.requestId === undefined || typeof raw.requestId !== "string") {
		return {
			ok: false,
			error: FeedbackValidationError.MissingRequestId,
			detail: "{ requestId } is required",
		};
	}
	if (raw.requestId.length === 0) {
		return {
			ok: false,
			error: FeedbackValidationError.MissingRequestId,
			detail: "{ requestId } must be non-empty",
		};
	}

	const payload: FeedbackPayload = {
		kind: raw.kind,
		title,
		body,
		sensitivity,
		includeRecentLog,
		clientVersion: raw.clientVersion,
		clientPlatform: raw.clientPlatform,
		submittedAt: raw.submittedAt,
		requestId: raw.requestId,
		...(contactEmail !== undefined ? { contactEmail } : {}),
		...(recentLogExcerpt !== undefined ? { recentLogExcerpt } : {}),
	};
	return { ok: true, payload };
}

function isFeedbackKind(value: unknown): value is FeedbackKind {
	return (
		value === FeedbackKind.Bug ||
		value === FeedbackKind.Idea ||
		value === FeedbackKind.Question ||
		value === FeedbackKind.Other
	);
}

function isFeedbackSensitivity(value: unknown): value is FeedbackSensitivity {
	return value === FeedbackSensitivity.Anonymous || value === FeedbackSensitivity.IdentityVoluntary;
}

/** Crockford-base32 alphabet per the ULID spec (no I, L, O, U to avoid
 *  visual confusion with digits). 32 chars / 5 bits per char. */
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Mint a ULID-shaped 26-char request id. Deterministic when `now` and
 *  `random` are pinned; production wires `Date.now` + `Math.random`. The
 *  first 10 chars encode the timestamp (millisecond precision), the
 *  remaining 16 chars are pure entropy.
 *
 *  Not cryptographically random — we don't need that here (the id is
 *  for server-side correlation, not authentication). `crypto.randomUUID`
 *  would do but introduces a non-deterministic axis the tests would have
 *  to mock; the `random()` callable keeps the surface trivially testable. */
export function newRequestId(now: number = Date.now(), random: () => number = Math.random): string {
	const timestamp = encodeTimestamp(Math.floor(now));
	const entropy = encodeEntropy(random);
	return timestamp + entropy;
}

function encodeTimestamp(ms: number): string {
	let value = Math.max(0, ms);
	const out = new Array<string>(10);
	for (let i = 9; i >= 0; i--) {
		const digit = value % 32;
		const char = CROCKFORD_BASE32[digit];
		out[i] = char ?? "0";
		value = Math.floor(value / 32);
	}
	return out.join("");
}

function encodeEntropy(random: () => number): string {
	const out = new Array<string>(16);
	for (let i = 0; i < 16; i++) {
		const sample = Math.floor(random() * 32) % 32;
		const char = CROCKFORD_BASE32[sample];
		out[i] = char ?? "0";
	}
	return out.join("");
}

/**
 * Feedback-1 — bug-report dialog.
 *
 * Privileged-only surface: opens from Settings → Privacy → Feedback and
 * from Help → "Send feedback". Sandboxed apps cannot render this; the
 * IPC channels behind it never reach an app preload.
 *
 * Form shape:
 *   - Kind segmented (Bug / Idea / Question / Other)
 *   - Title (200-char cap, counter)
 *   - Body textarea (10 000-char cap, counter, resizable)
 *   - Sensitivity segmented (Anonymous / Include my email)
 *   - Email input (conditional on IdentityVoluntary)
 *   - "Include recent log excerpt" toggle + collapsible preview
 *     showing the **redacted** excerpt as it would arrive on the wire
 *     (vault path → `<vault>`, home → `<home>/`, credentials →
 *     `<credential>`, emails → `<email>`) so the user sees exactly what
 *     gets shipped
 *   - Submit → toast on success, inline error on failure
 *     (5xx + transport errors are flagged caller-retryable; 4xx is not)
 *
 * Keyboard:
 *   - `shell/popover.close` (Escape) — closes the Popover
 *   - `shell/popover.confirm` (Enter) — submits when not focused in
 *     the multi-line textarea (the popover primitive already wires this)
 *
 * Localisation: every user-visible string flows through `t()`.
 */

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
	FeedbackKind,
	type FeedbackPayload,
	FeedbackSensitivity,
	type FeedbackSettings,
} from "../../feedback-wire-types";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { Segmented } from "../ui/segmented";
import { TextArea, TextField } from "../ui/text-field";
import "./feedback-dialog.css";

const TITLE_MAX_LENGTH = 200;
const BODY_MAX_LENGTH = 10_000;
const LOG_PREVIEW_FIRST_BYTES = 2 * 1024;

const KIND_ORDER: readonly FeedbackKind[] = [
	FeedbackKind.Bug,
	FeedbackKind.Idea,
	FeedbackKind.Question,
	FeedbackKind.Other,
];

const SENSITIVITY_ORDER: readonly FeedbackSensitivity[] = [
	FeedbackSensitivity.Anonymous,
	FeedbackSensitivity.IdentityVoluntary,
];

function kindLabelKey(kind: FeedbackKind): string {
	switch (kind) {
		case FeedbackKind.Bug:
			return "shell.feedback.kind.bug";
		case FeedbackKind.Idea:
			return "shell.feedback.kind.idea";
		case FeedbackKind.Question:
			return "shell.feedback.kind.question";
		case FeedbackKind.Other:
			return "shell.feedback.kind.other";
	}
}

function sensitivityLabelKey(sensitivity: FeedbackSensitivity): string {
	switch (sensitivity) {
		case FeedbackSensitivity.Anonymous:
			return "shell.feedback.sensitivity.anonymous";
		case FeedbackSensitivity.IdentityVoluntary:
			return "shell.feedback.sensitivity.identity";
	}
}

export type FeedbackDialogProps = {
	readonly onClose: () => void;
	readonly initialKind?: FeedbackKind;
	/** Test hooks; production wires `window.brainstorm.feedback.*`. */
	readonly submit?: (payload: FeedbackPayload) => Promise<{ ok: true; requestId: string }>;
	readonly fetchSettings?: () => Promise<FeedbackSettings>;
	readonly fetchRecentLog?: () => Promise<string>;
	readonly clientVersion?: string;
	readonly clientPlatform?: string;
	readonly now?: () => number;
	readonly newRequestId?: () => string;
};

type SubmitState =
	| { kind: "idle" }
	| { kind: "submitting" }
	| { kind: "success"; requestId: string }
	| { kind: "error"; message: string; retryable: boolean };

export function FeedbackDialog({
	onClose,
	initialKind = FeedbackKind.Bug,
	submit,
	fetchSettings,
	fetchRecentLog,
	clientVersion,
	clientPlatform,
	now,
	newRequestId,
}: FeedbackDialogProps) {
	const [kind, setKind] = useState<FeedbackKind>(initialKind);
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [sensitivity, setSensitivity] = useState<FeedbackSensitivity>(FeedbackSensitivity.Anonymous);
	const [contactEmail, setContactEmail] = useState("");
	const [includeRecentLog, setIncludeRecentLog] = useState(false);
	const [logPreviewOpen, setLogPreviewOpen] = useState(false);
	const [logPreview, setLogPreview] = useState<string>("");
	const [logPreviewLoading, setLogPreviewLoading] = useState(false);
	const [settings, setSettings] = useState<FeedbackSettings | null>(null);
	const [state, setState] = useState<SubmitState>({ kind: "idle" });

	const settingsFetcher = useMemo(
		() => fetchSettings ?? (async () => window.brainstorm.feedback.settings.get()),
		[fetchSettings],
	);
	const submitter = useMemo(
		() => submit ?? (async (payload: FeedbackPayload) => window.brainstorm.feedback.submit(payload)),
		[submit],
	);
	const recentLogFetcher = useMemo(
		() => fetchRecentLog ?? (async () => window.brainstorm.feedback.recentLog()),
		[fetchRecentLog],
	);

	useEffect(() => {
		let cancelled = false;
		settingsFetcher()
			.then((s) => {
				if (cancelled) return;
				setSettings(s);
			})
			.catch(() => {
				if (cancelled) return;
				setSettings(null);
			});
		return () => {
			cancelled = true;
		};
	}, [settingsFetcher]);

	useEffect(() => {
		if (!includeRecentLog) {
			setLogPreview("");
			return;
		}
		let cancelled = false;
		setLogPreviewLoading(true);
		recentLogFetcher()
			.then((log) => {
				if (cancelled) return;
				setLogPreview(log);
			})
			.catch(() => {
				if (cancelled) return;
				setLogPreview("");
			})
			.finally(() => {
				if (cancelled) return;
				setLogPreviewLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [includeRecentLog, recentLogFetcher]);

	const requestIdGenerator = useMemo(
		() => newRequestId ?? (() => makeRequestId(now ? now() : Date.now())),
		[newRequestId, now],
	);

	const formInvalid =
		title.trim().length === 0 ||
		title.length > TITLE_MAX_LENGTH ||
		body.trim().length === 0 ||
		body.length > BODY_MAX_LENGTH ||
		(sensitivity === FeedbackSensitivity.IdentityVoluntary &&
			contactEmail.length > 0 &&
			!isLikelyEmail(contactEmail));

	const onSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			if (formInvalid) return;
			const payload: FeedbackPayload = {
				kind,
				title: title.trim(),
				body,
				sensitivity,
				includeRecentLog,
				...(sensitivity === FeedbackSensitivity.IdentityVoluntary && contactEmail.trim().length > 0
					? { contactEmail: contactEmail.trim() }
					: {}),
				clientVersion: clientVersion ?? readClientVersion(),
				clientPlatform: clientPlatform ?? readClientPlatform(),
				submittedAt: now ? now() : Date.now(),
				requestId: requestIdGenerator(),
			};
			setState({ kind: "submitting" });
			try {
				const result = await submitter(payload);
				setState({ kind: "success", requestId: result.requestId });
			} catch (error) {
				setState({
					kind: "error",
					message: extractErrorMessage(error),
					retryable: isRetryableError(error),
				});
			}
		},
		[
			body,
			clientPlatform,
			clientVersion,
			contactEmail,
			formInvalid,
			includeRecentLog,
			kind,
			now,
			requestIdGenerator,
			sensitivity,
			submitter,
			title,
		],
	);

	const optInBanner = settings && !settings.enabled;
	const endpointMissingBanner = settings?.enabled && settings.endpoint === null;

	return (
		<Popover
			title={t("shell.feedback.title")}
			onClose={onClose}
			size={PopoverSize.Large}
			bodyPadding={PopoverBodyPadding.Comfortable}
			testId="feedback-dialog"
		>
			<form className="feedback-dialog" onSubmit={onSubmit} data-testid="feedback-form">
				{optInBanner && (
					<p className="feedback-dialog__banner" role="alert">
						{t("shell.feedback.optInBanner")}
					</p>
				)}
				{endpointMissingBanner && (
					<p className="feedback-dialog__banner" role="alert">
						{t("shell.feedback.endpointMissingBanner")}
					</p>
				)}

				<fieldset className="feedback-dialog__field">
					<legend className="feedback-dialog__legend">{t("shell.feedback.kindLabel")}</legend>
					<div className="feedback-dialog__segmented-host">
						<Segmented
							value={kind}
							onChange={setKind}
							aria-label={t("shell.feedback.kindLabel")}
							options={KIND_ORDER.map((option) => ({
								value: option,
								label: t(kindLabelKey(option)),
								testId: `feedback-kind-${option}`,
							}))}
						/>
					</div>
				</fieldset>

				<TextField
					label={t("shell.feedback.titleLabel")}
					counter={`${title.length} / ${TITLE_MAX_LENGTH}`}
					value={title}
					onChange={(next) => setTitle(next.slice(0, TITLE_MAX_LENGTH))}
					maxLength={TITLE_MAX_LENGTH}
					required
					data-testid="feedback-title"
				/>

				<TextArea
					label={t("shell.feedback.bodyLabel")}
					counter={`${body.length} / ${BODY_MAX_LENGTH}`}
					value={body}
					onChange={(next) => setBody(next.slice(0, BODY_MAX_LENGTH))}
					maxLength={BODY_MAX_LENGTH}
					rows={8}
					required
					data-testid="feedback-body"
				/>

				<fieldset className="feedback-dialog__field">
					<legend className="feedback-dialog__legend">{t("shell.feedback.sensitivityLabel")}</legend>
					<div className="feedback-dialog__segmented-host">
						<Segmented
							value={sensitivity}
							onChange={setSensitivity}
							aria-label={t("shell.feedback.sensitivityLabel")}
							options={SENSITIVITY_ORDER.map((option) => ({
								value: option,
								label: t(sensitivityLabelKey(option)),
								testId: `feedback-sensitivity-${option}`,
							}))}
						/>
					</div>
				</fieldset>

				{sensitivity === FeedbackSensitivity.IdentityVoluntary && (
					<TextField
						label={t("shell.feedback.emailLabel")}
						type="email"
						value={contactEmail}
						onChange={setContactEmail}
						placeholder={t("shell.feedback.emailPlaceholder")}
						hint={t("shell.feedback.emailHint")}
						autoComplete="email"
						data-testid="feedback-email"
					/>
				)}

				<div className="feedback-dialog__log">
					<Checkbox
						checked={includeRecentLog}
						onChange={setIncludeRecentLog}
						label={t("shell.feedback.includeLog")}
						data-testid="feedback-include-log"
					/>
					{includeRecentLog && (
						<>
							<button
								type="button"
								className="feedback-dialog__log-toggle"
								onClick={() => setLogPreviewOpen((open) => !open)}
								aria-expanded={logPreviewOpen}
								data-testid="feedback-log-toggle"
							>
								{logPreviewOpen ? t("shell.feedback.logPreviewHide") : t("shell.feedback.logPreviewShow")}
							</button>
							{logPreviewOpen && (
								<pre className="feedback-dialog__log-preview" data-testid="feedback-log-preview">
									{logPreviewLoading ? t("shell.feedback.logPreviewLoading") : clipLogPreview(logPreview)}
								</pre>
							)}
						</>
					)}
				</div>

				{state.kind === "error" && (
					<p className="feedback-dialog__error" role="alert" data-testid="feedback-error">
						{state.message}
					</p>
				)}
				{state.kind === "success" && (
					<p className="feedback-dialog__success" role="status" data-testid="feedback-success">
						{t("shell.feedback.success", { requestId: state.requestId })}
					</p>
				)}

				<div className="feedback-dialog__footer">
					<Button
						type="button"
						variant={ButtonVariant.Ghost}
						size={ButtonSize.Md}
						onClick={onClose}
						data-testid="feedback-cancel"
					>
						{t("shell.actions.cancel")}
					</Button>
					<Button
						type="submit"
						variant={ButtonVariant.Primary}
						size={ButtonSize.Md}
						loading={state.kind === "submitting"}
						disabled={
							formInvalid ||
							state.kind === "submitting" ||
							state.kind === "success" ||
							(settings !== null && !settings.enabled) ||
							(settings !== null && settings.endpoint === null)
						}
						data-testid="feedback-submit"
					>
						{t("shell.feedback.send")}
					</Button>
				</div>
			</form>
		</Popover>
	);
}

function clipLogPreview(text: string): string {
	if (text.length <= LOG_PREVIEW_FIRST_BYTES) return text;
	return `${text.slice(0, LOG_PREVIEW_FIRST_BYTES)}\n…(${text.length - LOG_PREVIEW_FIRST_BYTES} bytes more)`;
}

function isLikelyEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function readClientVersion(): string {
	try {
		const v = (globalThis as { __BRAINSTORM_BUILD_SHA__?: string }).__BRAINSTORM_BUILD_SHA__;
		return typeof v === "string" && v.length > 0 ? v : "dev";
	} catch (_error) {
		return "dev";
	}
}

function readClientPlatform(): string {
	const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
	if (!nav) return "unknown";
	if (typeof nav.platform === "string" && nav.platform.length > 0) return nav.platform;
	if (typeof nav.userAgent === "string" && nav.userAgent.length > 0) return nav.userAgent;
	return "unknown";
}

/** Renderer-side request id matching the main-side `newRequestId` shape
 *  — 26-char Crockford-base32, timestamp + entropy. We don't strictly
 *  need entropy parity with main; this just gives the dialog a stable
 *  visible "your report id" even before the round-trip lands. */
function makeRequestId(now: number): string {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let timestamp = "";
	let value = Math.max(0, Math.floor(now));
	for (let i = 0; i < 10; i++) {
		const digit = value % 32;
		timestamp = (alphabet[digit] ?? "0") + timestamp;
		value = Math.floor(value / 32);
	}
	let entropy = "";
	for (let i = 0; i < 16; i++) {
		const sample = Math.floor(Math.random() * 32);
		entropy += alphabet[sample] ?? "0";
	}
	return timestamp + entropy;
}

function extractErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return t("shell.feedback.errorUnknown");
}

function isRetryableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message ?? "";
	// `FeedbackError.message` format: `<kind>: <detail>` from
	// `feedback-service.ts:FeedbackError.constructor`. Server-error +
	// network-error are caller-retryable; rejected + opt-in + invalid
	// payload are not.
	return /network-error|server-error/.test(message);
}

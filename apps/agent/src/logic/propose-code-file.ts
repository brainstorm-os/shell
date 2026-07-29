/**
 * AppForge-3 — the agent proposes a CODE FILE (`brainstorm/CodeFile/v1`).
 *
 * The eighth propose kind, same contract as the other seven: the model's
 * `propose-code-file` call stages a bounded draft card; NOTHING persists until
 * the user approves it, and the approval is exactly one `entities.create`
 * (`propose-persist.ts`) shaped like the Code editor's own new-file path
 * (`apps/code-editor` creates `{path, content, language}` — the source text
 * lives in the `content` property; the editor seeds its Y.Doc buffer from it
 * on first open, so a file created this way opens cleanly).
 *
 * SECURITY:
 *  - `path` is a VAULT-resident organizing string, never a filesystem path.
 *    It gets the same treatment as the Code editor's rename validation
 *    (`sanitizeInlineText`: control/zero-width/bidi-strip + clamp) so it can
 *    never smuggle spoofing characters into the sidebar/window chrome. No
 *    code anywhere treats it as disk semantics.
 *  - `content` is untrusted model output: size-bounded here (REFUSED beyond
 *    {@link CODE_FILE_CONTENT_MAX}, not silently truncated — the model is told
 *    why), rendered inert in the tray preview (text nodes only), and persisted
 *    as plain data the Code editor renders as text.
 *  - the tool is offered only when the conversation's frozen capability set
 *    holds `entities.write:brainstorm/CodeFile/v1` ({@link canProposeCodeFiles})
 *    AND `intents.dispatch:propose-code-file` (the loop's intersection) — the
 *    same fail-closed offer gate the row tool uses.
 *
 * Pure + framework-free, exhaustively unit-tested without a runtime.
 */

import { capabilityImplies } from "@brainstorm-os/sdk-types";
import { CodeLanguage, detectLanguage, isCodeLanguage } from "@brainstorm-os/sdk/language-detect";
import { sanitizeInlineText } from "@brainstorm-os/sdk/sanitize-text";
import { ProposeKind, type ProposedArtifact } from "./propose-artifacts";

/** The tool verb the model calls to stage a code file. */
export const PROPOSE_CODE_FILE_VERB = "propose-code-file";

/** The entity type the Code editor owns and renders (its manifest registers
 *  the schema; `apps/code-editor/src/runtime.ts` declares the same id). */
export const CODE_FILE_ENTITY_TYPE = "brainstorm/CodeFile/v1";

/** The write cap an approved code file exercises — and the offer-time gate. */
export const CODE_FILE_WRITE_CAPABILITY = `entities.write:${CODE_FILE_ENTITY_TYPE}`;

/** Upper bound on proposed source content (UTF-16 code units, ~256 KiB).
 *  A draft beyond this is REFUSED, not clamped — silently truncated code is
 *  worse than no code. */
export const CODE_FILE_CONTENT_MAX = 256 * 1024;

/** Same clamp the Code editor's rename path applies (`MAX_RENAME_LENGTH`). */
export const CODE_FILE_PATH_MAX = 200;

/** The code-file payload a {@link ProposeKind.CodeFile} artifact carries:
 *  the resolved language (model-supplied when valid, else inferred from the
 *  path/first line, mirroring the Code editor's own detection fallback). */
export type ProposedCodeFile = {
	language: CodeLanguage;
};

export enum CodeFileRejectReason {
	/** No usable `path` (empty, or nothing survives sanitization). */
	MissingPath = "missing-path",
	/** `content` exceeds {@link CODE_FILE_CONTENT_MAX}. */
	ContentTooLarge = "content-too-large",
}

export type BuildCodeFileResult =
	| { ok: true; artifact: ProposedArtifact }
	| { ok: false; reason: CodeFileRejectReason };

/** Resolve the draft's language: a valid model-supplied id wins; otherwise
 *  infer from the path + first line (shebang), degrading to PlainText exactly
 *  like the Code editor's projection does for unclassified rows. */
export function resolveProposedLanguage(
	rawLanguage: unknown,
	path: string,
	content: string,
): CodeLanguage {
	if (isCodeLanguage(rawLanguage) && rawLanguage !== CodeLanguage.Unknown) return rawLanguage;
	const detected = detectLanguage(
		{ path, firstLine: content.split("\n", 1)[0] ?? "" },
		{ fallback: CodeLanguage.PlainText },
	);
	return detected === CodeLanguage.Unknown ? CodeLanguage.PlainText : detected;
}

/**
 * Stage a `propose-code-file` tool call into a bounded {@link ProposedArtifact}.
 * SECURITY: `path` is sanitized + clamped (spoofing-alphabet strip, same as the
 * Code editor's rename), `content` must be a string within the size bound or
 * the call is refused, `language` is validated against the known enum (never a
 * free string), and only these three fields survive — anything else the model
 * sent is dropped. No side effects: nothing is persisted.
 */
export function buildCodeFileProposal(input: {
	verb: string;
	args: Record<string, unknown>;
	id: string;
}): BuildCodeFileResult {
	const path = sanitizeInlineText(input.args.path, CODE_FILE_PATH_MAX);
	if (!path) return { ok: false, reason: CodeFileRejectReason.MissingPath };

	const rawContent = input.args.content;
	const content = typeof rawContent === "string" ? rawContent : "";
	if (content.length > CODE_FILE_CONTENT_MAX) {
		return { ok: false, reason: CodeFileRejectReason.ContentTooLarge };
	}

	const language = resolveProposedLanguage(input.args.language, path, content);

	return {
		ok: true,
		artifact: {
			id: input.id,
			kind: ProposeKind.CodeFile,
			entityType: CODE_FILE_ENTITY_TYPE,
			fields: { path, content },
			summary: path,
			codeFile: { language },
		},
	};
}

/** The ack fed back to the model — same contract as every propose tool:
 *  staged, NOT saved. A refusal names the reason so the model can correct
 *  (supply a path / send smaller content). */
export function buildCodeFileProposalAck(result: BuildCodeFileResult): Record<string, unknown> {
	if (!result.ok) return { staged: false, reason: result.reason };
	return {
		staged: true,
		status: "pending-approval",
		kind: ProposeKind.CodeFile,
		summary: result.artifact.summary,
		language: result.artifact.codeFile?.language ?? CodeLanguage.PlainText,
		note:
			"Queued for the user's review. It is NOT saved until the user approves it — do not tell the user it is done.",
	};
}

/** Fail-closed at OFFER time: the tool is only shown to the model when the
 *  conversation's frozen capability set can actually write a `CodeFile/v1`
 *  (mirrors `writableDatabaseSchemas` — never offer an affordance whose
 *  approval would be denied). */
export function canProposeCodeFiles(capabilities: readonly string[]): boolean {
	return capabilities.some((held) => capabilityImplies(held, CODE_FILE_WRITE_CAPABILITY));
}

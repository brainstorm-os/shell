/**
 * 9.12.16-UI — pure orchestrator for the Files-host `requestOpen` →
 * `read` → `runImport` pipeline. The UI half (toolbar trigger,
 * confirmation modal) calls this once on click; everything below the
 * `Promise<PickAndParseResult>` boundary is testable without a DOM,
 * without a vault session, and without the entities service.
 *
 * The kind discriminator collapses every terminal state — cancelled
 * picker, no mapper for the file's extension, read error, parse error
 * (yields zero drafts), or a clean `ImportRun` ready to commit — into
 * a single switch the caller can render the right toast / modal off.
 * Never throws.
 *
 * Mirrors the disposition pattern the SDK's `requestSaveBytes` (9.17.8b)
 * established for the save side: tagged result, encoder thunk shields
 * cancellation, every error path collapses to a `Failed`-shaped value.
 */

import type { ExistingEntity, ImportRun, TypeImportMapper } from "./import-registry";
import { importMapperForExtension, runImport } from "./import-registry";

/** Minimal slice of `FilesService` (Stage 9.10) the import flow needs.
 *  Narrowed here so callers don't depend on the full surface to wire one
 *  toolbar button. Mirrors `@brainstorm-os/sdk/export-file::SaveFileService`. */
export type ImportFileService = {
	requestOpen(opts?: {
		readonly title?: string;
		readonly filters?: readonly {
			readonly name: string;
			readonly extensions: readonly string[];
		}[];
		readonly multi?: boolean;
	}): Promise<readonly { readonly handleId: string; readonly displayName: string }[]>;
	read(handle: { readonly handleId: string; readonly displayName: string }): Promise<Uint8Array>;
};

/** Terminal-state discriminator the orchestrator returns. Five branches
 *  because the UI surfaces each one as a distinct affordance: a silent
 *  no-op (Cancelled), a polite explanation (NoMapper), a fail-loud
 *  error toast (Failed), an empty-but-not-error case (EmptyParse — the
 *  file was valid but yielded zero drafts), and the happy path (Ready
 *  with a populated ImportRun). */
export enum PickAndParseKind {
	/** User dismissed the OS picker. Not an error — mirrors the 9.10
	 *  `requestOpen → []` cancellation contract. */
	Cancelled = "cancelled",
	/** Extension is outside every registered mapper's support list.
	 *  Surface as "Unsupported file type" — explained, not silent. */
	NoMapper = "no-mapper",
	/** `services.files.read` rejected. Most often filesystem permission
	 *  errors after a registry-side handle revocation. */
	Failed = "failed",
	/** The mapper parsed the file but produced zero drafts. The file is
	 *  well-formed (no error to surface) but commit would be a no-op;
	 *  the UI shows "Nothing to import" rather than opening the
	 *  confirmation modal on an empty plan. */
	EmptyParse = "empty-parse",
	/** The pipeline produced a plannable `ImportRun`. The caller opens
	 *  the confirmation modal off `run.summary`. */
	Ready = "ready",
}

export type PickAndParseResult =
	| { readonly kind: PickAndParseKind.Cancelled }
	| {
			readonly kind: PickAndParseKind.NoMapper;
			readonly filename: string;
			readonly extension: string;
	  }
	| { readonly kind: PickAndParseKind.Failed; readonly filename: string; readonly error: unknown }
	| {
			readonly kind: PickAndParseKind.EmptyParse;
			readonly filename: string;
			readonly run: ImportRun;
			readonly mapper: TypeImportMapper;
	  }
	| {
			readonly kind: PickAndParseKind.Ready;
			readonly filename: string;
			readonly run: ImportRun;
			/** The resolved mapper — the caller re-derives `commands` /
			 *  `summary` from `run.plan` + the preview grid's overrides via
			 *  `mapper.commandsFor` / `mapper.summarize`. */
			readonly mapper: TypeImportMapper;
	  };

/** Run the Files-host pick → read → parse → plan pipeline, then return
 *  the disposition. Takes the service + the existing rows snapshot as
 *  parameters so it stays pure (no runtime singleton reach).
 *
 *  `filename` lookup is the first picked handle's `displayName` (the
 *  shell already stripped any path component for security). The mapper
 *  is resolved via the extension; `extension` is the lowercased tail
 *  after the last `.`. Files without an extension fall through to
 *  `NoMapper` rather than guessing — explicit beats clever for an
 *  import surface that writes to the user's vault.
 *
 *  Bytes decode as UTF-8 with `fatal: false` — a vCard / CSV with a
 *  stray malformed sequence still parses (the BOM-tolerant text
 *  parsers downstream handle stray bytes), and the modal's count
 *  summary lets the user notice if a row went missing. */
export async function pickAndParseImport(
	files: ImportFileService,
	opts: {
		readonly mappers: readonly TypeImportMapper[];
		readonly existing: readonly ExistingEntity[];
		readonly title?: string;
		readonly filterName?: string;
	},
): Promise<PickAndParseResult> {
	const extensions = collectExtensions(opts.mappers);
	const handles = await files.requestOpen({
		filters: [{ name: opts.filterName ?? "Import", extensions }],
		multi: false,
		...(opts.title !== undefined ? { title: opts.title } : {}),
	});
	const handle = handles[0];
	if (!handle) return { kind: PickAndParseKind.Cancelled };

	const filename = handle.displayName;
	const extension = extensionOf(filename);
	const mapper = extension ? findMapperForExtension(opts.mappers, extension) : null;
	if (!mapper) return { kind: PickAndParseKind.NoMapper, filename, extension };

	let bytes: Uint8Array;
	try {
		bytes = await files.read(handle);
	} catch (error) {
		return { kind: PickAndParseKind.Failed, filename, error };
	}

	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	} catch (error) {
		// `TextDecoder` with `fatal:false` doesn't normally throw, but the
		// shape is paranoid: a custom polyfill (or a future strict-mode
		// caller) could, and we'd rather surface a clean Failed disposition
		// than crash the click handler.
		return { kind: PickAndParseKind.Failed, filename, error };
	}

	let run: ImportRun;
	try {
		run = runImport(mapper, filename, text, opts.existing);
	} catch (error) {
		return { kind: PickAndParseKind.Failed, filename, error };
	}

	if (run.drafts.length === 0) {
		return { kind: PickAndParseKind.EmptyParse, filename, run, mapper };
	}
	return { kind: PickAndParseKind.Ready, filename, run, mapper };
}

/** Lowercased tail after the last `.`, or `""` for filenames with no
 *  extension. Dotfiles like `.vcf-backup` (single leading dot) return
 *  `""` — the leading dot is conventionally the start of a "hidden"
 *  filename rather than an extension separator. */
function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	if (dot <= 0 || dot === filename.length - 1) return "";
	return filename.slice(dot + 1).toLowerCase();
}

/** Walk `mappers` to find one that lists `extension` in its support
 *  set. Caller-provided list keeps the orchestrator pure — no reach
 *  into the global `importMapperForExtension` registry, so tests can
 *  inject deterministic mapper sets without touching module state. */
function findMapperForExtension(
	mappers: readonly TypeImportMapper[],
	extension: string,
): TypeImportMapper | null {
	for (const mapper of mappers) {
		if (mapper.extensions.includes(extension)) return mapper;
	}
	return null;
}

/** Flatten the union of every mapper's extension list, dedupe, and
 *  sort. Passed straight to the picker's `filters[0].extensions`. */
function collectExtensions(mappers: readonly TypeImportMapper[]): string[] {
	const seen = new Set<string>();
	for (const mapper of mappers) {
		for (const ext of mapper.extensions) seen.add(ext);
	}
	return [...seen].sort();
}

/** Snapshot of the global registry the orchestrator's caller would
 *  pass — provided so callers that DO want the convenience of the
 *  registered set don't have to enumerate it themselves. Mirrors
 *  `importMapperForExtension` shape but returns the full set. The
 *  orchestrator itself stays pure (the parameter is the only input). */
export function activeImportMappers(): readonly TypeImportMapper[] {
	// We re-derive by walking a known-extensions set against the registry.
	// `importMapperForExtension` is the only public lookup; iterate the
	// short list of extensions we care about and dedupe by reference.
	const tried = new Set<string>();
	const out: TypeImportMapper[] = [];
	// vCard + CSV are the contacts mapper today; tighten the loop when the
	// registry grows a public `list()` (forward-stage cleanup).
	for (const ext of ["vcf", "csv"]) {
		if (tried.has(ext)) continue;
		tried.add(ext);
		const mapper = importMapperForExtension(ext);
		if (mapper && !out.includes(mapper)) out.push(mapper);
	}
	return out;
}

/**
 * Re-export shim — the transclusion render context now lives in the
 * shared `@brainstorm-os/editor` package (it has zero Notes coupling and is
 * consumed by Journal / Tasks too). Notes-local imports keep working
 * through this file; new code should import from `@brainstorm-os/editor`
 * directly.
 */

export {
	type TransclusionBodyRenderer,
	type TransclusionRenderContextValue,
	type TransclusionRenderProviderProps,
	TransclusionRenderProvider,
	useTransclusionRender,
} from "@brainstorm-os/editor";

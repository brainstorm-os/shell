/**
 * The `- [<entityId>] <title>` citation line format — ONE source shared by the
 * retrieval emitter (`buildRetrievalContextBlock`) and the transcript parser
 * (`linkifyEntityRefs`), so the shape the model is taught and the shape the
 * display layer rewrites can't drift.
 */

/** An entity-id-shaped token: a short lowercase alnum prefix (≤8 chars,
 *  letter-first), then one or more underscore-joined lowercase alnum segments.
 *  Matches every id this codebase mints — the shell's `ent_<ts36><rand36>`,
 *  Notes' `n_<ts36>_<rand36>`, app-local `task_*`/`bm_*`/`wb_*`, dev-seed
 *  `mkt_*` — while rejecting prose brackets (`[x]`, `[TODO]`, `[1]`). Plain
 *  snake_case prose (`max_retries`) still fits this shape; the parser
 *  disambiguates by position/digit (see `linkifyEntityRefs`). */
export const CITATION_ID_SOURCE = "[a-z][a-z0-9]{0,7}(?:_[a-z0-9]+)+";

/** One retrieval-context citation line: `- [<entityId>] <text>`. The emitter
 *  passes `title — snippet` as the text; the parser's anchored-citation branch
 *  accepts exactly this shape. */
export function formatCitationLine(entityId: string, text: string): string {
	return `- [${entityId}] ${text}`;
}

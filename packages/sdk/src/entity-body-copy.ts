/**
 * Copy an entity's rich-text body from one entity onto another over the
 * `entities.*` Y.Doc transport (B11.10 templates foundation, 66-templates.md
 * §Instantiation / §The shared surfaces).
 *
 * The universal body (`"root"` Y.XmlText, plus any other Y.Doc structure the
 * source carries) lives in the entity's Y.Doc, *not* its property bag — so the
 * pure template codec deliberately defers the body copy to the consuming
 * surface. This is that surface, shared so "new X from template Y" and "Save as
 * template" both copy the body the same way (no per-app reimplementation).
 *
 * Mechanism: `loadDoc(src)` hands back `Y.encodeStateAsUpdate(srcDoc)` — a full
 * state update (the snapshot+tail already merged in-memory by the ydoc worker),
 * so replaying it onto a fresh destination doc via `applyDoc(dst, …)`
 * reconstructs the body byte-identically. No Yjs types cross the boundary; the
 * transport is base64 updates, capability-gated (read to load, write to apply).
 */

/** The slice of `EntitiesService` this helper needs — just the doc transport.
 *  A structural subset so the helper stays usable from any surface that holds
 *  an `entities` service without importing the full type. */
export type EntityBodyDocTransport = {
	loadDoc(id: string): Promise<{ snapshotB64: string; truncatedTail: boolean }>;
	applyDoc(id: string, updateB64: string): Promise<unknown>;
	closeDoc(id: string): Promise<void>;
};

/** Narrow a possibly-partial `entities` service to one that carries the body
 *  Y.Doc transport. A host without it (preview / standalone-dev) skips the body
 *  copy; the property copy still works. Lets a call site guard with a single
 *  check that also narrows the type (an inline `svc.loadDoc && svc.applyDoc`
 *  truthiness check narrows the *methods* but not the object). */
export function hasBodyDocTransport(
	svc: Partial<EntityBodyDocTransport>,
): svc is EntityBodyDocTransport {
	return (
		typeof svc.loadDoc === "function" &&
		typeof svc.applyDoc === "function" &&
		typeof svc.closeDoc === "function"
	);
}

/**
 * Copy the body Y.Doc of `srcId` onto `dstId`. Resolves once the destination
 * has the source's body applied; the source doc handle is released afterward so
 * a one-shot copy never leaves a doc pinned in the worker cache.
 *
 * `dstId` should be a freshly-created entity (an empty body) — applying the
 * source's full state onto a non-empty doc would *merge*, not replace. Both
 * call sites (create-from-template, save-as-template) create the destination
 * immediately before copying, so this holds by construction.
 */
export async function copyEntityBody(
	transport: EntityBodyDocTransport,
	srcId: string,
	dstId: string,
): Promise<void> {
	const { snapshotB64 } = await transport.loadDoc(srcId);
	try {
		await transport.applyDoc(dstId, snapshotB64);
	} finally {
		await transport.closeDoc(srcId).catch(() => {});
	}
}

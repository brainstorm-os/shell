/**
 * Where the feedback + crash collector lives, for this build.
 *
 * This exists because the obvious mechanism silently does not work. The main
 * process read `process.env.BRAINSTORM_FEEDBACK_ENDPOINT` directly, and the plan
 * recorded the remaining work as "bake it into the release workflow
 * (one-liner)". It is not: nothing in the bundler replaces that expression, so
 * the built `out/main/index.js` still contains a RUNTIME `process.env` read.
 * Setting the variable in CI therefore changes nothing — the packaged app
 * evaluates it on the user's machine, where it is unset, and every report is
 * dropped with no error anywhere.
 *
 * Verified rather than reasoned: building with the variable set produced a
 * bundle containing no trace of the value and an intact `process.env` read.
 *
 * So the value is now inlined by an electron-vite `define`, and this resolves
 * the two sources with the runtime env winning — a developer or CI run pointing
 * at a localhost collector must still be able to override a baked production
 * endpoint.
 */

/** Injected by electron-vite's `define`. Empty string ⇒ no endpoint baked. */
declare const __BRAINSTORM_FEEDBACK_ENDPOINT__: string;

export type FeedbackEndpointSources = {
	/** `process.env.BRAINSTORM_FEEDBACK_ENDPOINT` — dev/CI override. */
	runtime?: string | undefined;
	/** The value inlined at build time. */
	baked?: string | undefined;
};

/**
 * The endpoint to use, or `null` when this build has none.
 *
 * Runtime beats baked so a localhost collector can be pointed at during
 * development. Blank/whitespace counts as absent in both — an env var set to the
 * empty string is how CI expresses "no endpoint", and it must not read as a
 * usable URL.
 */
export function resolveFeedbackEndpoint(sources: FeedbackEndpointSources): string | null {
	const runtime = sources.runtime?.trim();
	if (runtime) return runtime;
	const baked = sources.baked?.trim();
	return baked ? baked : null;
}

/** The value this build baked in, if any. Safe when the define is absent (tests,
 *  the vitest runner) — `typeof` on an undeclared identifier does not throw. */
export function bakedFeedbackEndpoint(): string | undefined {
	return typeof __BRAINSTORM_FEEDBACK_ENDPOINT__ === "string"
		? __BRAINSTORM_FEEDBACK_ENDPOINT__
		: undefined;
}

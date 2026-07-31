/**
 * Visual harness re-export of the perf-harness launcher. Visual capture and
 * perf measurement use the same prerequisites (production-built shell,
 * insecure-dev keystore, isolated `--user-data-dir`), so the actual
 * launch lives in one place — `tests/perf/lib/launch-shell.ts` — and we
 * pull it through here so callers can stay scoped to `tests/visual/lib/`.
 */

export {
	hiddenWindowEnv,
	launchShell,
	shellBuildExists,
	type LaunchOptions,
	type LaunchResult,
} from "../../perf/lib/launch-shell";

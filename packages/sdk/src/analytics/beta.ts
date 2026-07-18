/** True while the product ships pre-1.0 (public beta). Analytics runs only then. */
export function isPublicBeta(version: string): boolean {
	const core = version.trim().split("-")[0] ?? "";
	const major = Number.parseInt(core.split(".")[0] ?? "", 10);
	return !Number.isFinite(major) || major < 1;
}

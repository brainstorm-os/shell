/**
 * Normalize a raw vault create/open failure into a stable, PII-free code for
 * analytics. The raw `Error.message` embeds absolute paths (→ the OS username)
 * and must never be sent; only the code below leaves the device.
 *
 * Classification is by message prefix rather than `error.code`, because the
 * error crosses IPC from the main process and custom props don't survive that
 * clone reliably — but Node fs errors and our own thrown strings both carry a
 * stable prefix in `message` (`EACCES: …`, `Directory is not empty: …`).
 */

export enum VaultErrorCode {
	DirectoryNotEmpty = "directory_not_empty",
	NotADirectory = "not_a_directory",
	PermissionDenied = "permission_denied",
	ReadOnly = "read_only",
	NoSpace = "no_space",
	PathMissing = "path_missing",
	NameMissing = "name_missing",
	NotFound = "not_found",
	Unknown = "unknown",
}

export function classifyVaultError(error: unknown): VaultErrorCode {
	const message = error instanceof Error ? error.message : String(error ?? "");
	if (/^Directory is not empty:/i.test(message)) return VaultErrorCode.DirectoryNotEmpty;
	if (/^Not a directory:/i.test(message)) return VaultErrorCode.NotADirectory;
	if (/^Vault path is required/i.test(message)) return VaultErrorCode.PathMissing;
	if (/^Vault name is required/i.test(message)) return VaultErrorCode.NameMissing;
	if (/^E(ACCES|PERM)\b/.test(message)) return VaultErrorCode.PermissionDenied;
	if (/^EROFS\b/.test(message)) return VaultErrorCode.ReadOnly;
	if (/^ENOSPC\b/.test(message)) return VaultErrorCode.NoSpace;
	if (/^ENOENT\b/.test(message)) return VaultErrorCode.NotFound;
	return VaultErrorCode.Unknown;
}

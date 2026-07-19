/**
 * Sync-failure classification (F-445). The driver surfaces wire errors
 * verbatim; the banner must speak human for the two repairable classes —
 * credentials and connectivity — and offer the reconnect affordance for
 * both (Edit connection fixes a bad host exactly like a bad password).
 */

export enum SyncErrorClass {
	Auth = "auth",
	Connect = "connect",
	Other = "other",
}

const CONNECT_RE =
	/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|EPIPE|Socket timeout|certificate|self[ -]signed|getaddrinfo/i;

export function classifySyncError(message: string): SyncErrorClass {
	if (/authentication failed/i.test(message)) return SyncErrorClass.Auth;
	if (CONNECT_RE.test(message)) return SyncErrorClass.Connect;
	return SyncErrorClass.Other;
}

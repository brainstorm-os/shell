/**
 * Broker service handler for `files` (9.10) — the capability-gated,
 * app-reachable filesystem surface every app uses to open / save / read /
 * write user-chosen files. **Apps never see absolute paths** (
 * §Filesystem); the registry mints opaque tokens and this handler is the
 * single gate that swaps token → path inside the trusted main process.
 *
 * Methods:
 *   - `requestOpen(opts)` → `FileHandle[]` (or `[]` when the user cancels)
 *     · `files.read`-gated; one handle per chosen file, minted scoped to
 *       the calling app.
 *   - `requestSave(opts)` → `FileHandle | null`
 *     · `files.write`-gated; one writeable handle for the chosen target.
 *   - `read({ handleId })` → `{ base64 }`
 *     · `files.read`-gated; resolver-side check fails closed on a forged
 *       or cross-app token (the registry returns `null`); size-bounded
 *       per `MAX_WRITE_BYTES` (same ceiling as write — symmetric envelope
 *       budget).
 *   - `write({ handleId, data })` → `void`
 *     · `files.write`-gated; requires `canWrite(handle)`; normalises via
 *       `decodeWriteData` so a non-binary / over-ceiling payload returns
 *       `Invalid`, never throws into the FS.
 *   - `watch({ handleId })` → `{ subscriptionId }`
 *     · `files.read`-gated; subscribes to file-modified events via
 *       `node:fs.watch`; events fan out to every live window of the
 *       owning app via the `app:files-watch` channel. Unsubscribe via
 *       `unwatch({ subscriptionId })`.
 *   - `unwatch({ subscriptionId })` → `boolean`
 *     · `files.read`-gated; idempotent. Releases the underlying watcher.
 *   - `handleFromIntent({ token })` → `FileHandle | null`
 *     · `files.read`-gated; the cross-app pass-through. A producing app
 *       (e.g. Files) attaches its own token to an inbound intent (e.g.
 *       `view` on a CSV); the receiving app (Database) feeds that token
 *       here, the registry resolves it shell-internal, and a *fresh*
 *       token scoped to the receiving app is minted (the receiver never
 *       sees the source token, never sees the path).
 *   - `import({ handleId } | { name, data })` → `FileImportReply`
 *     · `files.read`-gated; copies a user-chosen file's bytes INTO the
 *       vault's encrypted AssetStore (`AssetKind.Upload`) and returns the
 *       `{assetId, contentHash, size, mime, name}` the caller persists on
 *       its `File/v1` entity. Two variants: by handle (picker flow — main
 *       reads the path itself, bytes never cross IPC) and by bytes
 *       (drag-in flow — the drop gesture is the user mediation, mirroring
 *       the picker; payload rides the same `{base64}` envelope shape as
 *       `write`). The STORED mime comes from the conservative
 *       `servedMimeForName` allow-list (see `upload-mime.ts`) so the
 *       asset protocol can never serve active content.
 *
 * Cancellation is data, not an error: the broker would otherwise log a
 * user-cancelled picker as a denial. `requestOpen` returns `[]`,
 * `requestSave` returns `null`.
 *
 * Thin on purpose: every validation byte lives in the three 9.10(a)
 * keystones (`file-handle-registry`, `dialog-options`, `file-io-guards`).
 * This file is dispatch + dialog wiring + watcher lifecycle.
 */

import type { FSWatcher } from "node:fs";
import { watch as fsWatch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { StoredAsset } from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import type { FileWatchGrantsRepository } from "../storage/registry-repo/file-watch-grants-repo";
import {
	type NormalizedOpenDialog,
	type NormalizedSaveDialog,
	normalizeOpenDialog,
	normalizeSaveDialog,
} from "./dialog-options";
import {
	type FileHandleInfo,
	FileHandleMode,
	type FileHandleRegistry,
} from "./file-handle-registry";
import { MAX_WRITE_BYTES, WriteRejectReason, decodeWriteData } from "./file-io-guards";
import { servedMimeForName } from "./upload-mime";

/** Channel name the preload app-side listener subscribes to. Mirrors the
 *  `app:vault-entities-changed` pattern from `vault-entities-broadcast.ts`
 *  — payload-carrying because the app needs to know *which* subscription
 *  fired (one app can hold many watches). */
export const APP_FILES_WATCH_CHANNEL = "app:files-watch";

/** Bound on concurrent watches per app — a misbehaving app cannot exhaust
 *  the kernel's `inotify` quota in a tight loop. */
const MAX_WATCHES_PER_APP = 128;

/** The reply the renderer's `read` proxy reshapes into a `Uint8Array`. */
export type FilesReadReply = { base64: string };

/** The reply of `files.import` — what the caller persists on its `File/v1`
 *  entity. `mime` is the SERVED mime (allow-listed; see `upload-mime.ts`),
 *  not necessarily the extension-truthful one. */
export type FileImportReply = {
	assetId: string;
	contentHash: string;
	size: number;
	mime: string;
	name: string;
};

/** Hook that seals bytes into the active vault's encrypted `AssetStore`
 *  (kind `Upload`) and marks the asset bound — the upload gesture IS the
 *  binding intent, so a stored upload is never orphan-reap-eligible. The
 *  production wire lives in `main/index.ts`; tests pass a fake. */
export type StoreUploadAsset = (input: {
	bytes: Uint8Array;
	mime: string;
}) => Promise<{ assetId: string; contentHash: string }>;

/** SDK-side `FileHandle` shape — opaque token + a display name the picker
 *  surfaced so a UI can label the row without re-asking. Matches
 *  `@brainstorm-os/sdk-types`'s `FileHandle`. */
export type FileHandleWire = { handleId: string; displayName: string };

/** Result of a `showOpenDialog` callback. `canceled === true` returns an
 *  empty `filePaths`; the handler maps that to `[]` (data, not an error). */
export type OpenDialogResult = { canceled: boolean; filePaths: string[] };
export type SaveDialogResult = { canceled: boolean; filePath: string | null };

/** `appId` is the requesting app so the production wire can parent the OS
 *  dialog to THAT app's window (not the dashboard). A dialog parented to the
 *  wrong window steals focus to it — on macOS the file sheet drags the parent
 *  window forward, hiding the app that asked. */
export type ShowOpenDialog = (
	options: NormalizedOpenDialog,
	appId: string,
) => Promise<OpenDialogResult>;
export type ShowSaveDialog = (
	options: NormalizedSaveDialog,
	appId: string,
) => Promise<SaveDialogResult>;

/** Hook the broker uses to fan a watch event out to every window of the
 *  owning app. The production wire injects this via the launcher's
 *  `allWindows()`; tests pass a spy. */
export type WatchEmitter = (
	appId: string,
	event: { subscriptionId: string; handleId: string; kind: WatchEventKind },
) => void;

export enum WatchEventKind {
	/** The watched path was modified (content / metadata change). */
	Changed = "changed",
	/** The watcher errored / the file disappeared — the subscription is
	 *  still live but the app should re-query / re-pick. */
	Errored = "errored",
}

export type FilesServiceOptions = {
	/** The active vault's handle registry, or null when no session is open
	 *  (→ Unavailable). One-call accessor so the handler stays vault-aware
	 *  without holding a stale reference across `setActiveVaultSession`. */
	getRegistry: () => FileHandleRegistry | null;
	/** 11b.10 — the active vault's persistent file-watch grant store, or null
	 *  when no session is open. Backs `requestWatchGrant` (a picked file that
	 *  survives a vault reopen); the path stays shell-internal. Absent (older
	 *  test wires) ⇒ `requestWatchGrant` returns `Unavailable`. */
	getFileWatchGrants?: (() => FileWatchGrantsRepository | null) | undefined;
	/** Electron `dialog.showOpenDialog` wrapper. Injected so unit tests can
	 *  mock the picker — the broker still passes normalised options. */
	showOpenDialog: ShowOpenDialog;
	/** Electron `dialog.showSaveDialog` wrapper. Same shape. */
	showSaveDialog: ShowSaveDialog;
	/** Push a watch event to every live window of `appId`. */
	emitWatch: WatchEmitter;
	/** Filesystem reader — injected for tests. Defaults to `node:fs.promises`. */
	readFile?: ((path: string) => Promise<Buffer>) | undefined;
	/** Filesystem writer — injected for tests. */
	writeFile?: ((path: string, data: Uint8Array) => Promise<void>) | undefined;
	/** Watcher factory — injected for tests. Returns a node `FSWatcher`-shaped
	 *  object: an `EventEmitter` with `change` / `error` events and `close()`. */
	watchFile?: ((path: string) => FSWatcher) | undefined;
	/** Vault asset-store writer backing `files.import`. Absent (older test
	 *  wires) → `import` returns `Unavailable`, never a partial store. */
	storeUploadAsset?: StoreUploadAsset | undefined;
	/** Build the cross-store storage inventory (uploads + covers + wallpapers
	 *  + icons) for the Files "Storage" view. The fs/db gathering lives in the
	 *  production wire (`index.ts`); absent (older test wires) → `[]`. */
	listStorageInventory?: (() => Promise<readonly StoredAsset[]>) | undefined;
};

function invalid(message: string): Error {
	const err = new Error(message);
	err.name = "Invalid";
	return err;
}

function unavailable(message: string): Error {
	const err = new Error(message);
	err.name = "Unavailable";
	return err;
}

function requireRegistry(options: FilesServiceOptions): FileHandleRegistry {
	const registry = options.getRegistry();
	if (!registry) throw unavailable("files: no active vault session");
	return registry;
}

function requireHandleId(envelope: Envelope, method: string): string {
	const [arg] = envelope.args as [unknown];
	if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
		throw invalid(`files.${method}: argument must be an object`);
	}
	const handleId = (arg as Record<string, unknown>).handleId;
	if (typeof handleId !== "string" || handleId.length === 0) {
		throw invalid(`files.${method}: handleId must be a non-empty string`);
	}
	return handleId;
}

function resolveOwnedHandle(
	registry: FileHandleRegistry,
	app: string,
	handleId: string,
	method: string,
): { path: string; mode: FileHandleMode } {
	const resolution = registry.resolve(app, handleId);
	if (!resolution) {
		// Fail-closed: unknown / revoked / cross-app token → `Invalid`. The
		// `Invalid` (not `Unavailable`) shape lets a renderer distinguish
		// "transient — retry" from "your handle is dead, re-pick".
		throw invalid(`files.${method}: handle is unknown, revoked, or not yours`);
	}
	return resolution;
}

function toFileHandleWire(info: FileHandleInfo): FileHandleWire {
	return { handleId: info.token, displayName: basename(info.path) };
}

function encodeBase64(bytes: Uint8Array): string {
	// Node-side. The renderer-side decode is in the SDK proxy.
	return Buffer.from(bytes).toString("base64");
}

type WatchRecord = {
	subscriptionId: string;
	appId: string;
	handleId: string;
	watcher: FSWatcher;
};

export function makeFilesServiceHandler(options: FilesServiceOptions): ServiceHandler {
	const fsRead = options.readFile ?? ((p: string) => readFile(p));
	const fsWrite = options.writeFile ?? ((p: string, data: Uint8Array) => writeFile(p, data));
	const fsWatcher = options.watchFile ?? ((p: string) => fsWatch(p));

	// Single watcher map for the handler's lifetime; revoking a handle / a
	// vault close tears down via `disposeWatchersFor` (below). The map key
	// is the subscription id so unwatch is O(1).
	const watches = new Map<string, WatchRecord>();
	const watchesByApp = new Map<string, Set<string>>();

	let watchSeq = 0;
	const nextSubscriptionId = (): string => {
		watchSeq += 1;
		return `fw_${Date.now().toString(36)}_${watchSeq.toString(36)}`;
	};

	function disposeWatch(subscriptionId: string): boolean {
		const rec = watches.get(subscriptionId);
		if (!rec) return false;
		try {
			rec.watcher.close();
		} catch {
			// best-effort
		}
		watches.delete(subscriptionId);
		const appSet = watchesByApp.get(rec.appId);
		if (appSet) {
			appSet.delete(subscriptionId);
			if (appSet.size === 0) watchesByApp.delete(rec.appId);
		}
		return true;
	}

	async function handleRequestOpen(envelope: Envelope): Promise<FileHandleWire[]> {
		const registry = requireRegistry(options);
		const normalized = normalizeOpenDialog(envelope.args[0]);
		const result = await options.showOpenDialog(normalized, envelope.app);
		if (result.canceled || result.filePaths.length === 0) return [];
		const handles: FileHandleWire[] = [];
		for (const path of result.filePaths) {
			const token = registry.mint(envelope.app, path, FileHandleMode.Read);
			handles.push({ handleId: token, displayName: basename(path) });
		}
		return handles;
	}

	/** 11b.10 — pick a file for a FileWatch trigger and persist the grant so it
	 *  survives a vault reopen. Same dialog as `requestOpen`, but the pick is
	 *  recorded in the persistent `file_watch_grants` store (path shell-internal)
	 *  and the app gets only the opaque `watchId` + a displayName. */
	async function handleRequestWatchGrant(
		envelope: Envelope,
	): Promise<{ watchId: string; displayName: string } | null> {
		const grants = options.getFileWatchGrants?.();
		if (!grants) throw unavailable("files.requestWatchGrant: no active vault session");
		const normalized = normalizeOpenDialog(envelope.args[0]);
		const result = await options.showOpenDialog(normalized, envelope.app);
		if (result.canceled || result.filePaths.length === 0) return null;
		const path = result.filePaths[0] as string;
		const watchId = grants.mint(envelope.app, path, FileHandleMode.Read);
		return { watchId, displayName: basename(path) };
	}

	async function handleRequestSave(envelope: Envelope): Promise<FileHandleWire | null> {
		const registry = requireRegistry(options);
		const normalized = normalizeSaveDialog(envelope.args[0]);
		const result = await options.showSaveDialog(normalized, envelope.app);
		if (result.canceled || !result.filePath) return null;
		const token = registry.mint(envelope.app, result.filePath, FileHandleMode.ReadWrite);
		return { handleId: token, displayName: basename(result.filePath) };
	}

	async function handleRead(envelope: Envelope): Promise<FilesReadReply> {
		const registry = requireRegistry(options);
		const handleId = requireHandleId(envelope, "read");
		const { path } = resolveOwnedHandle(registry, envelope.app, handleId, "read");
		const buffer = await fsRead(path);
		// A real user file can be large; the registry mints an opaque token
		// but the wire is a single envelope. Bound the read to the same
		// ceiling we bound writes to — `9.10a` lifts both via streaming.
		if (buffer.byteLength > MAX_WRITE_BYTES) {
			throw invalid(`files.read: file exceeds ${MAX_WRITE_BYTES} bytes`);
		}
		return { base64: encodeBase64(buffer) };
	}

	async function handleWrite(envelope: Envelope): Promise<void> {
		const registry = requireRegistry(options);
		const [arg] = envelope.args as [unknown];
		if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
			throw invalid("files.write: argument must be an object");
		}
		const a = arg as Record<string, unknown>;
		if (typeof a.handleId !== "string" || a.handleId.length === 0) {
			throw invalid("files.write: handleId must be a non-empty string");
		}
		// Resolve + canWrite — second-line defence even though the registry
		// already enforces the mode on resolve.
		const { path, mode } = resolveOwnedHandle(registry, envelope.app, a.handleId, "write");
		if (mode !== FileHandleMode.ReadWrite) {
			throw invalid("files.write: handle is read-only");
		}
		const decoded = decodeWriteData(a.data);
		if (!decoded.ok) {
			// All write-side rejections collapse to `Invalid`. Keep the
			// reason in the message so the SDK error carries enough signal.
			throw invalid(`files.write: ${decoded.message} (${decoded.reason})`);
		}
		await fsWrite(path, decoded.bytes);
	}

	function handleWatch(envelope: Envelope): { subscriptionId: string } {
		const registry = requireRegistry(options);
		const handleId = requireHandleId(envelope, "watch");
		const { path } = resolveOwnedHandle(registry, envelope.app, handleId, "watch");

		const appSet = watchesByApp.get(envelope.app) ?? new Set<string>();
		if (appSet.size >= MAX_WATCHES_PER_APP) {
			throw invalid(`files.watch: ${envelope.app} has too many active watches`);
		}

		const subscriptionId = nextSubscriptionId();
		const watcher = fsWatcher(path);
		const rec: WatchRecord = { subscriptionId, appId: envelope.app, handleId, watcher };
		watches.set(subscriptionId, rec);
		appSet.add(subscriptionId);
		watchesByApp.set(envelope.app, appSet);

		watcher.on("change", () => {
			options.emitWatch(rec.appId, {
				subscriptionId: rec.subscriptionId,
				handleId: rec.handleId,
				kind: WatchEventKind.Changed,
			});
		});
		watcher.on("error", () => {
			options.emitWatch(rec.appId, {
				subscriptionId: rec.subscriptionId,
				handleId: rec.handleId,
				kind: WatchEventKind.Errored,
			});
		});

		return { subscriptionId };
	}

	function handleUnwatch(envelope: Envelope): boolean {
		const [arg] = envelope.args as [unknown];
		if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
			throw invalid("files.unwatch: argument must be an object");
		}
		const subscriptionId = (arg as Record<string, unknown>).subscriptionId;
		if (typeof subscriptionId !== "string" || subscriptionId.length === 0) {
			throw invalid("files.unwatch: subscriptionId must be a non-empty string");
		}
		const rec = watches.get(subscriptionId);
		if (!rec) return false;
		// Cross-app unwatch fail-closed: an app can't kill another app's
		// watcher even if it guesses the id.
		if (rec.appId !== envelope.app) return false;
		return disposeWatch(subscriptionId);
	}

	async function handleImport(envelope: Envelope): Promise<FileImportReply> {
		const store = options.storeUploadAsset;
		if (!store) throw unavailable("files.import: asset store not wired");
		const [arg] = envelope.args as [unknown];
		if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
			throw invalid("files.import: argument must be an object");
		}
		const a = arg as Record<string, unknown>;

		let bytes: Uint8Array;
		let name: string;
		if (typeof a.handleId === "string" && a.handleId.length > 0) {
			// Picker flow — main reads the path itself; bytes never cross IPC.
			const registry = requireRegistry(options);
			const { path } = resolveOwnedHandle(registry, envelope.app, a.handleId, "import");
			const buffer = await fsRead(path);
			if (buffer.byteLength > MAX_WRITE_BYTES) {
				throw invalid(`files.import: file exceeds ${MAX_WRITE_BYTES} bytes`);
			}
			bytes = new Uint8Array(buffer);
			name = basename(path);
		} else {
			// Drag-in flow — bytes ride the same `{base64}` shape as `write`,
			// same ceiling, same rejection taxonomy.
			if (typeof a.name !== "string" || a.name.length === 0) {
				throw invalid("files.import: name must be a non-empty string");
			}
			const decoded = decodeWriteData(a.data);
			if (!decoded.ok) {
				throw invalid(`files.import: ${decoded.message} (${decoded.reason})`);
			}
			bytes = decoded.bytes;
			name = basename(a.name);
		}

		const mime = servedMimeForName(name);
		const { assetId, contentHash } = await store({ bytes, mime });
		return { assetId, contentHash, size: bytes.byteLength, mime, name };
	}

	function handleHandleFromIntent(envelope: Envelope): FileHandleWire | null {
		const registry = requireRegistry(options);
		const [arg] = envelope.args as [unknown];
		if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
			throw invalid("files.handleFromIntent: argument must be an object");
		}
		const sourceToken = (arg as Record<string, unknown>).token;
		if (typeof sourceToken !== "string" || sourceToken.length === 0) {
			throw invalid("files.handleFromIntent: token must be a non-empty string");
		}
		// Shell-internal lookup — does NOT require knowing the source app
		// (that's the whole point: the receiver never sees the source token's
		// owning app id). Unknown token → null, never throw.
		const source = registry.resolveAny(sourceToken);
		if (!source) return null;
		// A receiver requesting a handle to its own existing handle is a
		// no-op idempotent reuse — same (app, path, mode) → same token.
		// We deliberately downgrade to Read for the cross-app pass: an
		// intent that wants the receiver to write must request a Save
		// dialog in the receiver, not piggy-back on the producer's grant.
		const token = registry.mint(envelope.app, source.path, FileHandleMode.Read);
		return { handleId: token, displayName: basename(source.path) };
	}

	return async (envelope: Envelope): Promise<unknown> => {
		switch (envelope.method) {
			case "requestOpen":
				return handleRequestOpen(envelope);
			case "requestWatchGrant":
				return handleRequestWatchGrant(envelope);
			case "requestSave":
				return handleRequestSave(envelope);
			case "read":
				return handleRead(envelope);
			case "write":
				return handleWrite(envelope);
			case "watch":
				return handleWatch(envelope);
			case "unwatch":
				return handleUnwatch(envelope);
			case "import":
				return handleImport(envelope);
			case "handleFromIntent":
				return handleHandleFromIntent(envelope);
			case "listStorageInventory":
				return (await options.listStorageInventory?.()) ?? [];
			default:
				throw invalid(`unknown files method: ${envelope.method}`);
		}
	};
}

/** Re-export so the SDK proxy + tests share the same constant. */
export { MAX_WRITE_BYTES, WriteRejectReason };

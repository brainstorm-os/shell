/**
 * Yjs document persistence per §Yjs document persistence.
 *
 * Layout — one file per entity at `<vault>/data/docs/<id-prefix>/<id>.ydoc`,
 * where `<id-prefix>` is the first three characters of the entity id (sharded
 * to keep any one directory small). Inside each file:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ magic   : 4 bytes  'YDOC'                                     │
 *   │ version : uint32  LE  ( == 1 )                                │
 *   │ snap_len: uint32  LE  ( length of snapshot, may be 0 )        │
 *   │ snapshot: snap_len bytes — Y.encodeStateAsUpdate(doc)         │
 *   │ ── tail entries follow until EOF ──                            │
 *   │ tail_entry:                                                    │
 *   │    update_len: uint32 LE                                       │
 *   │    update    : update_len bytes — Y.encodeStateAsUpdate(doc)   │
 *   │    crc32     : uint32 LE — CRC-32 of `update`                  │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Read = read header → snapshot → loop tail entries (skip the last one if it
 * has a corrupt CRC, since a partial-write at process crash can leave a
 * truncated final entry). Apply all updates to a fresh Y.Doc.
 *
 * Compact = read everything, encode the resulting Y.Doc as a single update,
 * write a new file with that as the snapshot, then atomically replace.
 *
 * Stage 3 ships the format, read+write+compaction. The yjs **worker
 * process** (OQ-18 resolution) hosts the canonical Y.Doc and uses this
 * module as its persistence backend; the worker itself lands in this stage's
 * `ydoc-worker` module.
 *
 * Encryption note: per the on-disk bytes
 * should be ciphertext under the entity DEK. Stage 3 stores plaintext for
 * the same reason `entities.db` does (OQ-34 deferral); Stage 10 wraps the
 * snapshot + each tail entry with XChaCha20-Poly1305 under the entity DEK.
 */

import { Buffer } from "node:buffer";
import { access, appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { crc32 } from "node:zlib";
import * as Y from "yjs";

const MAGIC = Buffer.from("YDOC", "ascii");
const FORMAT_VERSION = 1;
const HEADER_BYTES = 4 /* magic */ + 4 /* version */ + 4 /* snap_len */;

/** Default tail-size threshold past which we compact (per §256KB). */
export const DEFAULT_COMPACT_THRESHOLD = 256 * 1024;

export type YDocStoreOptions = {
	/** Override the base directory. Defaults to `<vaultPath>/data/docs`. */
	docsDir?: string;
	/** Compact when the tail grows past this many bytes. */
	compactThresholdBytes?: number;
};

export type LoadResult = {
	doc: Y.Doc;
	/** Number of tail entries successfully applied. */
	tailEntries: number;
	/** When true, the last tail entry was corrupt (truncated / mismatched CRC) and was skipped. */
	truncatedTail: boolean;
	/** When true, the reconstructed doc holds structs Yjs CANNOT integrate:
	 *  they name a `left`/`parent` from a client whose update never reached
	 *  this file, so they sit in `pendingStructs` and the content they carry
	 *  is invisible forever — no read path will ever surface it. Distinct
	 *  from `truncatedTail`: every byte here is intact and CRC-clean, the
	 *  hole is a *missing* update, not a damaged one. The 329 audit found 7
	 *  Journal days in this state (a blank body under a "5 words" counter);
	 *  the renderer-side cause is fixed in `@brainstorm-os/react-yjs`'s
	 *  resolver, and this flag is how a survivor stops being silent. */
	pendingStructs: boolean;
};

export class YDocStore {
	private readonly baseDir: string;
	private readonly compactThresholdBytes: number;

	constructor(vaultPath: string, options: YDocStoreOptions = {}) {
		this.baseDir = options.docsDir ?? join(vaultPath, "data", "docs");
		this.compactThresholdBytes = options.compactThresholdBytes ?? DEFAULT_COMPACT_THRESHOLD;
	}

	pathFor(entityId: string): string {
		const prefix = entityId.slice(0, 3) || "_";
		const filePath = join(this.baseDir, prefix, `${entityId}.ydoc`);
		// Final backstop (the id-charset guards at the service + worker
		// boundaries are the primary fix): refuse to hand back any path that
		// resolves outside the vault docs dir, so a traversing id can never
		// drive a `mkdir`/`writeFile` here even if both upstream guards were
		// bypassed.
		const root = resolve(this.baseDir);
		const resolved = resolve(filePath);
		if (resolved !== root && !resolved.startsWith(root + sep)) {
			throw new Error(`ydoc: entity id escapes the docs directory: ${JSON.stringify(entityId)}`);
		}
		return filePath;
	}

	/**
	 * Load an entity's Y.Doc from disk. Returns a fresh empty doc when the
	 * file is missing. Skips a corrupt final tail entry (logged via the
	 * `truncatedTail` flag) so a crashed-mid-write file is still usable.
	 */
	async load(entityId: string): Promise<LoadResult> {
		const filePath = this.pathFor(entityId);
		const doc = new Y.Doc();
		let raw: Buffer;
		try {
			raw = await readFile(filePath);
		} catch (error) {
			if (isNotFound(error)) {
				return { doc, tailEntries: 0, truncatedTail: false, pendingStructs: false };
			}
			throw error;
		}

		assertMagic(raw);
		const version = raw.readUInt32LE(4);
		if (version !== FORMAT_VERSION) {
			throw new Error(`ydoc: unsupported format version ${version}`);
		}
		const snapLen = raw.readUInt32LE(8);
		const snapEnd = HEADER_BYTES + snapLen;
		if (snapEnd > raw.length) {
			throw new Error(`ydoc: snapshot length ${snapLen} exceeds file size ${raw.length}`);
		}
		if (snapLen > 0) {
			Y.applyUpdate(doc, raw.subarray(HEADER_BYTES, snapEnd));
		}

		let offset = snapEnd;
		let tailEntries = 0;
		let truncatedTail = false;
		while (offset < raw.length) {
			if (raw.length - offset < 8) {
				truncatedTail = true; // not enough bytes for len + crc — partial
				break;
			}
			const updateLen = raw.readUInt32LE(offset);
			const updateStart = offset + 4;
			const updateEnd = updateStart + updateLen;
			const crcEnd = updateEnd + 4;
			if (crcEnd > raw.length) {
				truncatedTail = true;
				break;
			}
			const update = raw.subarray(updateStart, updateEnd);
			const storedCrc = raw.readUInt32LE(updateEnd);
			if (crc32(update) !== storedCrc) {
				truncatedTail = true;
				break;
			}
			Y.applyUpdate(doc, update);
			tailEntries += 1;
			offset = crcEnd;
		}
		return { doc, tailEntries, truncatedTail, pendingStructs: hasPendingStructs(doc) };
	}

	/**
	 * Append one Yjs update to the tail. Creates the file with an empty
	 * snapshot if it doesn't yet exist. Returns the new on-disk file size in
	 * bytes — callers compare against `compactThresholdBytes` to decide
	 * whether to compact.
	 */
	async appendUpdate(entityId: string, update: Uint8Array): Promise<number> {
		const filePath = this.pathFor(entityId);
		await mkdir(dirname(filePath), { recursive: true });

		let fileSize: number;
		try {
			const info = await stat(filePath);
			fileSize = info.size;
		} catch (error) {
			if (!isNotFound(error)) throw error;
			fileSize = 0;
		}

		if (fileSize === 0) {
			// New file — write header with empty snapshot.
			const header = Buffer.alloc(HEADER_BYTES);
			MAGIC.copy(header, 0);
			header.writeUInt32LE(FORMAT_VERSION, 4);
			header.writeUInt32LE(0, 8);
			await writeFile(filePath, header);
			fileSize = HEADER_BYTES;
		}

		const entry = encodeTailEntry(update);
		await appendFile(filePath, entry);
		return fileSize + entry.length;
	}

	/**
	 * Rewrite the file from a fresh snapshot. Used by compaction and by
	 * direct snapshot installs (e.g. after sync receives a remote state).
	 */
	async writeSnapshot(entityId: string, snapshot: Uint8Array): Promise<void> {
		const filePath = this.pathFor(entityId);
		await mkdir(dirname(filePath), { recursive: true });
		const buf = encodeFile(snapshot, []);
		// atomic-ish: write tmp then rename. Concurrent writeSnapshot calls
		// for the same entityId (e.g. dev seeders running two passes in
		// parallel) race on `tmpPath`: the second writeFile overwrites the
		// first, the first rename succeeds, the second sees ENOENT because
		// tmpPath is now gone. The data is the last writer's snapshot, and
		// `filePath` is already in place — the race is benign at this
		// layer. Tolerate ENOENT-on-rename when filePath exists; let any
		// other error (perm, disk full, etc.) propagate.
		const tmpPath = `${filePath}.tmp`;
		await writeFile(tmpPath, buf);
		try {
			await rename(tmpPath, filePath);
		} catch (error) {
			if (!isNotFound(error)) throw error;
			try {
				await access(filePath);
				// Another concurrent writer beat us to the rename — fine.
				return;
			} catch {
				throw error;
			}
		}
	}

	/**
	 * Merge the tail into a fresh snapshot. No-op if the file is missing or
	 * already compact (no tail entries). Returns the new file size.
	 */
	async compact(entityId: string): Promise<number> {
		const filePath = this.pathFor(entityId);
		let raw: Buffer;
		try {
			raw = await readFile(filePath);
		} catch (error) {
			if (isNotFound(error)) return 0;
			throw error;
		}
		assertMagic(raw);
		const snapLen = raw.readUInt32LE(8);
		const snapEnd = HEADER_BYTES + snapLen;
		if (snapEnd >= raw.length) return raw.length; // no tail, nothing to merge

		const { doc } = await this.load(entityId);
		const merged = Y.encodeStateAsUpdate(doc);
		await this.writeSnapshot(entityId, merged);
		const info = await stat(filePath);
		return info.size;
	}

	/**
	 * Convenience: append + compact when the file grew past the threshold.
	 * Returns whether compaction ran.
	 */
	async appendAndMaybeCompact(
		entityId: string,
		update: Uint8Array,
	): Promise<{ compacted: boolean; size: number }> {
		const size = await this.appendUpdate(entityId, update);
		if (size > this.compactThresholdBytes) {
			const compactedSize = await this.compact(entityId);
			return { compacted: true, size: compactedSize };
		}
		return { compacted: false, size };
	}
}

function encodeFile(snapshot: Uint8Array, tailEntries: Buffer[]): Buffer {
	const header = Buffer.alloc(HEADER_BYTES);
	MAGIC.copy(header, 0);
	header.writeUInt32LE(FORMAT_VERSION, 4);
	header.writeUInt32LE(snapshot.length, 8);
	const snap = Buffer.from(snapshot);
	return Buffer.concat([header, snap, ...tailEntries]);
}

function encodeTailEntry(update: Uint8Array): Buffer {
	const head = Buffer.alloc(4);
	head.writeUInt32LE(update.length, 0);
	const body = Buffer.from(update);
	const tail = Buffer.alloc(4);
	tail.writeUInt32LE(crc32(body) >>> 0, 0);
	return Buffer.concat([head, body, tail]);
}

function assertMagic(buf: Buffer): void {
	if (buf.length < HEADER_BYTES) {
		throw new Error("ydoc: file shorter than header");
	}
	if (!buf.subarray(0, 4).equals(MAGIC)) {
		throw new Error("ydoc: bad magic — not a YDOC file");
	}
}

/** Structs Yjs parked because the update they depend on never arrived.
 *  `Y.Doc.store.pendingStructs` is Yjs's own queue for them; it is non-null
 *  exactly while the doc is missing bytes it needs. Read-only probe — the
 *  caller decides what to do about it. */
function hasPendingStructs(doc: Y.Doc): boolean {
	return (doc.store as { pendingStructs?: unknown }).pendingStructs != null;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === "ENOENT"
	);
}

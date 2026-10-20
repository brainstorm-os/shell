/**
 * Version-history byte store (doc `version-history.md` §Checkpoint).
 *
 * One append-only file per entity at `<vault>/data/history/<prefix>/<id>.yhist`:
 *
 *   magic   : 4 bytes 'YHST'
 *   version : uint32 LE (== 1)
 *   frames  : `ydoc-frame` frames until EOF, one per checkpoint body
 *             (`Y.encodeStateAsUpdate` at capture time)
 *
 * A checkpoint is addressed by the `(offset, length)` of its frame, which the
 * `entity_versions` row holds. Frames go through the same codec as the `.ydoc`
 * tail, so the Stage 10 at-rest flip covers both files at once (OQ-VH-4).
 *
 * Device-local (OQ-VH-1): nothing here is read by sync, export or backup.
 *
 * Every mutation of one entity's file runs on that entity's lock, so an append
 * can never interleave with a rewrite of the same file.
 */

import { Buffer } from "node:buffer";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { assertSafeEntityId } from "./entity-id";
import { FRAME_OVERHEAD_BYTES, FrameReadStatus, encodeFrame, readFrameAt } from "./ydoc-frame";

const HIST_EXT = ".yhist";
const MAGIC = Buffer.from("YHST", "ascii");
const FORMAT_VERSION = 1;
export const YHIST_HEADER_BYTES = 8;

/** Where a checkpoint's body lives inside its entity's `.yhist`. `length` is
 *  the payload length (the frame adds `FRAME_OVERHEAD_BYTES`). */
export type HistFrameRef = { offset: number; length: number };

export class YHistStore {
	private readonly baseDir: string;
	private readonly locks = new Map<string, Promise<unknown>>();

	constructor(vaultPath: string, options: { historyDir?: string } = {}) {
		this.baseDir = options.historyDir ?? join(vaultPath, "data", "history");
	}

	pathFor(entityId: string): string {
		assertSafeEntityId(entityId);
		const prefix = entityId.slice(0, 3) || "_";
		const filePath = join(this.baseDir, prefix, `${entityId}${HIST_EXT}`);
		const root = resolve(this.baseDir);
		const resolved = resolve(filePath);
		if (!resolved.startsWith(root + sep)) {
			throw new Error(`yhist: entity id escapes the history directory: ${JSON.stringify(entityId)}`);
		}
		return filePath;
	}

	/** Append one checkpoint body. Creates the file on first use. */
	append(entityId: string, body: Uint8Array): Promise<HistFrameRef> {
		return this.withLock(entityId, async () => {
			const filePath = this.pathFor(entityId);
			await mkdir(dirname(filePath), { recursive: true });
			let size = await fileSize(filePath);
			if (size === 0) {
				await writeFile(filePath, header());
				size = YHIST_HEADER_BYTES;
			}
			const handle = await open(filePath, "a");
			try {
				await handle.write(encodeFrame(body));
			} finally {
				await handle.close();
			}
			return { offset: size, length: body.length };
		});
	}

	/** Read one checkpoint body. Throws on a ref that does not land on an
	 *  intact frame of exactly that length — a stale or forged ref must never
	 *  decode to someone else's bytes. */
	async read(entityId: string, ref: HistFrameRef): Promise<Uint8Array> {
		const raw = await readFile(this.pathFor(entityId));
		assertHeader(raw);
		if (!Number.isInteger(ref.offset) || ref.offset < YHIST_HEADER_BYTES) {
			throw named("Invalid", "yhist: bad frame offset");
		}
		const frame = readFrameAt(raw, ref.offset);
		if (frame.status !== FrameReadStatus.Ok) {
			throw named("Invalid", `yhist: frame at ${ref.offset} is ${frame.status}`);
		}
		if (frame.bytes.length !== ref.length) {
			throw named("Invalid", "yhist: frame length does not match its record");
		}
		return new Uint8Array(frame.bytes);
	}

	/**
	 * Rewrite the file keeping only `keep` (retention reclaim). Returns the new
	 * ref for every kept frame keyed by its old offset; a ref that does not
	 * resolve to an intact frame is dropped from the result. An empty `keep`
	 * removes the file.
	 */
	rewrite(entityId: string, keep: readonly HistFrameRef[]): Promise<Map<number, HistFrameRef>> {
		return this.withLock(entityId, async () => {
			const filePath = this.pathFor(entityId);
			const moved = new Map<number, HistFrameRef>();
			if (keep.length === 0) {
				await rm(filePath, { force: true });
				return moved;
			}
			let raw: Buffer;
			try {
				raw = await readFile(filePath);
			} catch (error) {
				if (isNotFound(error)) return moved;
				throw error;
			}
			assertHeader(raw);
			const parts: Buffer[] = [header()];
			let cursor = YHIST_HEADER_BYTES;
			const ordered = [...new Map(keep.map((r) => [r.offset, r])).values()].sort(
				(a, b) => a.offset - b.offset,
			);
			for (const ref of ordered) {
				const frame = readFrameAt(raw, ref.offset);
				if (frame.status !== FrameReadStatus.Ok || frame.bytes.length !== ref.length) continue;
				const encoded = encodeFrame(frame.bytes);
				parts.push(encoded);
				moved.set(ref.offset, { offset: cursor, length: ref.length });
				cursor += encoded.length;
			}
			const tmp = `${filePath}.tmp`;
			await writeFile(tmp, Buffer.concat(parts));
			await rename(tmp, filePath);
			return moved;
		});
	}

	remove(entityId: string): Promise<void> {
		return this.withLock(entityId, () => rm(this.pathFor(entityId), { force: true }));
	}

	/** Every entity id that has a history file (orphan sweeps). */
	async listEntityIds(): Promise<string[]> {
		let shards: string[];
		try {
			shards = await readdir(this.baseDir);
		} catch {
			return [];
		}
		const ids: string[] = [];
		for (const shard of shards) {
			let files: string[];
			try {
				files = await readdir(join(this.baseDir, shard));
			} catch {
				continue;
			}
			for (const f of files) if (f.endsWith(HIST_EXT)) ids.push(f.slice(0, -HIST_EXT.length));
		}
		return ids;
	}

	private withLock<T>(entityId: string, run: () => Promise<T>): Promise<T> {
		const prior = this.locks.get(entityId) ?? Promise.resolve();
		const next = prior.then(run, run);
		const settled = next.catch(() => undefined);
		this.locks.set(entityId, settled);
		void settled.then(() => {
			if (this.locks.get(entityId) === settled) this.locks.delete(entityId);
		});
		return next;
	}
}

/** Bytes a ref occupies on disk, frame overhead included. */
export function histFrameDiskBytes(ref: HistFrameRef): number {
	return ref.length + FRAME_OVERHEAD_BYTES;
}

function header(): Buffer {
	const buf = Buffer.alloc(YHIST_HEADER_BYTES);
	MAGIC.copy(buf, 0);
	buf.writeUInt32LE(FORMAT_VERSION, 4);
	return buf;
}

function assertHeader(raw: Buffer): void {
	if (raw.length < YHIST_HEADER_BYTES || !raw.subarray(0, 4).equals(MAGIC)) {
		throw new Error("yhist: bad magic — not a YHST file");
	}
	const version = raw.readUInt32LE(4);
	if (version !== FORMAT_VERSION) throw new Error(`yhist: unsupported format version ${version}`);
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if (isNotFound(error)) return 0;
		throw error;
	}
}

function named(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === "ENOENT"
	);
}

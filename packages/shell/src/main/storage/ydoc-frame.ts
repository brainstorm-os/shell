/**
 * The one on-disk frame shared by every Yjs byte store: the `.ydoc` tail
 * (`ydoc-store.ts`) and the `.yhist` version-history file (`yhist-store.ts`).
 *
 *   frame:
 *     len   : uint32 LE — length of `bytes`
 *     bytes : len bytes
 *     crc32 : uint32 LE — CRC-32 of `bytes`
 *
 * This is the at-rest seam (OQ-VH-4): Stage 10 seals each frame's `bytes`
 * under the entity DEK HERE, so the live document and its history can never
 * be at different protection levels — there is no second codec to forget.
 */

import { Buffer } from "node:buffer";
import { crc32 } from "node:zlib";

/** len prefix + crc suffix. */
export const FRAME_OVERHEAD_BYTES = 8;

export function encodeFrame(bytes: Uint8Array): Buffer {
	const head = Buffer.alloc(4);
	head.writeUInt32LE(bytes.length, 0);
	const body = Buffer.from(bytes);
	const tail = Buffer.alloc(4);
	tail.writeUInt32LE(crc32(body) >>> 0, 0);
	return Buffer.concat([head, body, tail]);
}

export enum FrameReadStatus {
	Ok = "ok",
	/** Fewer bytes remain than the frame claims — a crash mid-append. */
	Truncated = "truncated",
	/** The payload's CRC does not match — damaged bytes. */
	CorruptCrc = "corrupt-crc",
}

export type FrameRead =
	| { status: FrameReadStatus.Ok; bytes: Buffer; next: number }
	| { status: FrameReadStatus.Truncated | FrameReadStatus.CorruptCrc };

/** Read the frame starting at `offset`. The returned `bytes` is a view into
 *  `buf` — copy it if `buf` is reused. */
export function readFrameAt(buf: Buffer, offset: number): FrameRead {
	if (offset < 0 || buf.length - offset < FRAME_OVERHEAD_BYTES) {
		return { status: FrameReadStatus.Truncated };
	}
	const len = buf.readUInt32LE(offset);
	const start = offset + 4;
	const end = start + len;
	if (end + 4 > buf.length) return { status: FrameReadStatus.Truncated };
	const bytes = buf.subarray(start, end);
	if (crc32(bytes) >>> 0 !== buf.readUInt32LE(end)) return { status: FrameReadStatus.CorruptCrc };
	return { status: FrameReadStatus.Ok, bytes, next: end + 4 };
}

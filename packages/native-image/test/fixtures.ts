/**
 * Programmatic image fixtures — real, decodable PNGs built with nothing but
 * node:zlib, so the tests exercise the native decoder on genuine bytes
 * without binary files in the repo.
 */
import { deflateSync } from "node:zlib";

function crc32(buf: Buffer): number {
	let c = ~0;
	for (const b of buf) {
		c ^= b;
		for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}

export type PngOptions = {
	width: number;
	height: number;
	/** RGBA per-pixel fill. Alpha < 255 makes the image genuinely transparent. */
	rgba?: readonly [number, number, number, number];
	/** Add per-pixel variation so the bytes don't deflate to nothing. */
	noise?: boolean;
};

/** Build a real color-type-6 (RGBA) PNG. */
export function makePng(opts: PngOptions): Buffer {
	const { width, height } = opts;
	const [r, g, b, a] = opts.rgba ?? [200, 100, 50, 255];
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	const rows: Buffer[] = [];
	for (let y = 0; y < height; y += 1) {
		const row = Buffer.alloc(1 + width * 4);
		for (let x = 0; x < width; x += 1) {
			const off = 1 + x * 4;
			row[off] = opts.noise ? (r + x * 7 + y * 13) % 256 : r;
			row[off + 1] = opts.noise ? (g + x * 3) % 256 : g;
			row[off + 2] = opts.noise ? (b + y * 5) % 256 : b;
			row[off + 3] = a;
		}
		rows.push(row);
	}
	const idat = deflateSync(Buffer.concat(rows));
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", idat),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

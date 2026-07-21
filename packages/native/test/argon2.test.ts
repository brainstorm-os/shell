import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import { describe, expect, it } from "vitest";

type Native = {
	argon2idDerive: (
		passphrase: Uint8Array,
		salt: Uint8Array,
		mKib: number,
		tCost: number,
		pCost: number,
		outLen: number,
	) => Buffer;
};

const loadNative = async (): Promise<Native> => (await import("../index.js")) as unknown as Native;

const hex = (bytes: Uint8Array | Buffer): string =>
	Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("@brainstorm-os/native — argon2id (NAPI-2)", () => {
	it("matches @noble/hashes/argon2.js byte-for-byte at the shell's TEST_KDF profile", async () => {
		const { argon2idDerive } = await loadNative();
		const passphrase = utf8("hunter2");
		const salt = new Uint8Array(16).fill(0x42);

		const rust = argon2idDerive(passphrase, salt, 8, 1, 1, 32);
		const noble = nobleArgon2id(passphrase, salt, { m: 8, t: 1, p: 1, dkLen: 32 });

		expect(rust.length).toBe(32);
		expect(hex(rust)).toBe(hex(noble));
	});

	it("matches @noble/hashes/argon2.js at the OWASP-2024 production profile (m=64 MiB, t=3, p=4)", async () => {
		const { argon2idDerive } = await loadNative();
		const passphrase = utf8("correct horse battery staple");
		const salt = utf8("brainstorm-vault-salt-0");

		const rust = argon2idDerive(passphrase, salt, 65536, 3, 4, 32);
		const noble = nobleArgon2id(passphrase, salt, { m: 65536, t: 3, p: 4, dkLen: 32 });

		expect(rust.length).toBe(32);
		expect(hex(rust)).toBe(hex(noble));
	}, 30_000);

	it("matches @noble/hashes/argon2.js across non-default output lengths", async () => {
		const { argon2idDerive } = await loadNative();
		const passphrase = utf8("p");
		const salt = utf8("s-16-bytes-padding");

		for (const outLen of [16, 24, 32, 48, 64] as const) {
			const rust = argon2idDerive(passphrase, salt, 16, 2, 1, outLen);
			const noble = nobleArgon2id(passphrase, salt, { m: 16, t: 2, p: 1, dkLen: outLen });
			expect(rust.length, `outLen=${outLen} Rust length`).toBe(outLen);
			expect(hex(rust), `outLen=${outLen} mismatch`).toBe(hex(noble));
		}
	});

	it("is deterministic — same inputs → same output", async () => {
		const { argon2idDerive } = await loadNative();
		const passphrase = utf8("x");
		const salt = utf8("yyyyyyyyyyyyyyyy");
		const a = argon2idDerive(passphrase, salt, 8, 1, 1, 32);
		const b = argon2idDerive(passphrase, salt, 8, 1, 1, 32);
		expect(hex(a)).toBe(hex(b));
	});

	it("changes the derived key when any input bit changes", async () => {
		const { argon2idDerive } = await loadNative();
		const salt = utf8("ssssssssssssssss");
		const base = argon2idDerive(utf8("password"), salt, 8, 1, 1, 32);
		const flippedPassphrase = argon2idDerive(utf8("passwore"), salt, 8, 1, 1, 32);
		const flippedSalt = argon2idDerive(utf8("password"), utf8("tssssssssssssssss"), 8, 1, 1, 32);
		expect(hex(base)).not.toBe(hex(flippedPassphrase));
		expect(hex(base)).not.toBe(hex(flippedSalt));
	});

	it("rejects out_len = 0 with a clear error", async () => {
		const { argon2idDerive } = await loadNative();
		expect(() => argon2idDerive(utf8("p"), utf8("ssssssssssssssss"), 8, 1, 1, 0)).toThrow(/out_len/);
	});

	it("rejects invalid argon2 parameters (m_kib below the Argon2 floor)", async () => {
		const { argon2idDerive } = await loadNative();
		// Argon2 requires m_kib >= 8 * p_cost; (m=4, p=8) is below the floor.
		expect(() => argon2idDerive(utf8("p"), utf8("ssssssssssssssss"), 4, 1, 8, 32)).toThrow(
			/invalid argon2 params/i,
		);
	});
});

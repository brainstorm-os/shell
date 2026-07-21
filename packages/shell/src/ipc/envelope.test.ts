import { WEBVIEW_SERVICE } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	ENVELOPE_PROTOCOL_VERSION,
	type Envelope,
	isEnvelope,
	makeEnvelope,
	makeErrorReply,
	makeOkReply,
	validateEnvelope,
} from "./envelope";

const minimal: Envelope = {
	v: ENVELOPE_PROTOCOL_VERSION,
	msg: "req_1",
	app: "io.example.app",
	service: "storage",
	method: "get",
	args: [],
	caps: [],
};

describe("validateEnvelope", () => {
	it("accepts the minimal valid envelope", () => {
		const result = validateEnvelope(minimal);
		expect(result.ok).toBe(true);
	});

	it("rejects non-objects", () => {
		expect(validateEnvelope(null).ok).toBe(false);
		expect(validateEnvelope(undefined).ok).toBe(false);
		expect(validateEnvelope("string").ok).toBe(false);
		expect(validateEnvelope(42).ok).toBe(false);
	});

	it("rejects wrong protocol version", () => {
		const result = validateEnvelope({ ...minimal, v: 2 });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toMatch(/protocol/);
	});

	it("rejects missing/invalid msg", () => {
		expect(validateEnvelope({ ...minimal, msg: "" }).ok).toBe(false);
		expect(validateEnvelope({ ...minimal, msg: "x".repeat(200) }).ok).toBe(false);
		expect(validateEnvelope({ ...minimal, msg: "spaces are bad" }).ok).toBe(false);
		expect(validateEnvelope({ ...minimal, msg: 42 }).ok).toBe(false);
	});

	it("rejects missing/invalid app", () => {
		expect(validateEnvelope({ ...minimal, app: "" }).ok).toBe(false);
		expect(validateEnvelope({ ...minimal, app: "a".repeat(300) }).ok).toBe(false);
		expect(validateEnvelope({ ...minimal, app: "evil/path" }).ok).toBe(false);
	});

	it("rejects malformed service or method", () => {
		expect(validateEnvelope({ ...minimal, service: "Storage" }).ok).toBe(false);
		expect(validateEnvelope({ ...minimal, service: "" }).ok).toBe(false);
		expect(validateEnvelope({ ...minimal, method: "" }).ok).toBe(false);
		expect(validateEnvelope({ ...minimal, method: "with spaces" }).ok).toBe(false);
	});

	it("accepts every shipped wire service name (no camelCase regressions)", () => {
		// The Browser engine shipped registering its service as `"webView"`,
		// which the lowercase-only service pattern silently rejects — every
		// WebView call failed closed and the app rendered nothing. The wire name
		// is now the `WEBVIEW_SERVICE` constant; this pins it to the validator so
		// a camelCase name can never reach the broker again (session 192).
		expect(validateEnvelope({ ...minimal, service: WEBVIEW_SERVICE }).ok).toBe(true);
	});

	it("rejects non-array args or caps", () => {
		expect(validateEnvelope({ ...minimal, args: "x" }).ok).toBe(false);
		expect(validateEnvelope({ ...minimal, caps: "x" }).ok).toBe(false);
	});

	it("rejects malformed capability strings", () => {
		const result = validateEnvelope({ ...minimal, caps: ["NOPE.upper"] });
		expect(result.ok).toBe(false);
		const result2 = validateEnvelope({ ...minimal, caps: [42] });
		expect(result2.ok).toBe(false);
	});

	it("accepts well-formed scoped capabilities", () => {
		const result = validateEnvelope({
			...minimal,
			caps: ["entities.read:io.example/Note/v1", "storage.kv"],
		});
		expect(result.ok).toBe(true);
	});
});

describe("isEnvelope", () => {
	it("acts as a type guard", () => {
		expect(isEnvelope(minimal)).toBe(true);
		expect(isEnvelope({})).toBe(false);
	});
});

describe("makeEnvelope", () => {
	it("constructs envelopes with the canonical protocol version", () => {
		const e = makeEnvelope({
			msg: "m1",
			app: "io.example.app",
			service: "storage",
			method: "ping",
			args: [],
			caps: [],
		});
		expect(e.v).toBe(ENVELOPE_PROTOCOL_VERSION);
	});

	it("throws on malformed parts", () => {
		expect(() =>
			makeEnvelope({
				msg: "",
				app: "io.example.app",
				service: "storage",
				method: "ping",
				args: [],
				caps: [],
			}),
		).toThrow(/msg/);
	});
});

describe("reply builders", () => {
	it("makeOkReply carries msg + value + v", () => {
		const reply = makeOkReply("m1", { x: 1 });
		expect(reply).toEqual({
			v: ENVELOPE_PROTOCOL_VERSION,
			msg: "m1",
			ok: true,
			value: { x: 1 },
		});
	});

	it("makeErrorReply carries kind + message", () => {
		const reply = makeErrorReply("m1", { kind: "NotFound", message: "no" });
		expect(reply.v).toBe(ENVELOPE_PROTOCOL_VERSION);
		expect(reply.msg).toBe("m1");
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.kind).toBe("NotFound");
	});
});

// Stage 1.5 — property tests: random envelopes round-trip through the
// validator, and malformed envelopes are always rejected.
describe("envelope property tests", () => {
	const lowerLetters = "abcdefghijklmnopqrstuvwxyz";
	const allLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	const appCharset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";
	const msgCharset = appCharset;
	const serviceTailCharset = "abcdefghijklmnopqrstuvwxyz0123456789-";
	const methodTailCharset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
	const capHeadCharset = "abcdefghijklmnopqrstuvwxyz0123456789._-";

	function pick(charset: string): string {
		return charset[Math.floor(Math.random() * charset.length)] ?? "a";
	}

	function randomString(charset: string, min: number, max: number): string {
		const length = Math.floor(Math.random() * (max - min + 1)) + min;
		let out = "";
		for (let i = 0; i < length; i++) out += pick(charset);
		return out;
	}

	function randomEnvelopeLike(): Envelope {
		const msg = randomString(msgCharset, 1, 128);
		const app = randomString(appCharset, 1, 256);
		const service = (pick(lowerLetters) + randomString(serviceTailCharset, 0, 63)).slice(0, 64);
		const method = (pick(allLetters) + randomString(methodTailCharset, 0, 63)).slice(0, 64);
		const argsLength = Math.floor(Math.random() * 5);
		const args: unknown[] = [];
		for (let i = 0; i < argsLength; i++) {
			args.push(Math.random() < 0.5 ? Math.random() : randomString(appCharset, 0, 10));
		}
		const capsLength = Math.floor(Math.random() * 4);
		const caps: string[] = [];
		for (let i = 0; i < capsLength; i++) {
			const head = pick(lowerLetters) + randomString(capHeadCharset, 0, 16);
			caps.push(Math.random() < 0.5 ? head : `${head}:scope.${randomString(appCharset, 1, 12)}`);
		}
		return {
			v: ENVELOPE_PROTOCOL_VERSION,
			msg,
			app,
			service,
			method,
			args,
			caps,
		};
	}

	it("100 randomly-generated valid envelopes round-trip cleanly", () => {
		for (let i = 0; i < 100; i++) {
			const envelope = randomEnvelopeLike();
			const result = validateEnvelope(envelope);
			if (!result.ok) {
				throw new Error(`Random envelope rejected: ${result.reason} :: ${JSON.stringify(envelope)}`);
			}
			expect(result.envelope).toEqual(envelope);
		}
	});

	it("flipping any required field to a bad value always rejects", () => {
		const fields: (keyof Envelope)[] = ["v", "msg", "app", "service", "method", "args", "caps"];
		for (let i = 0; i < 50; i++) {
			const envelope = randomEnvelopeLike();
			for (const field of fields) {
				const bad = { ...envelope, [field]: undefined };
				expect(validateEnvelope(bad).ok).toBe(false);
			}
		}
	});

	it("missing or extra protocol version is always rejected", () => {
		for (let i = 0; i < 20; i++) {
			const envelope = randomEnvelopeLike();
			expect(validateEnvelope({ ...envelope, v: 0 }).ok).toBe(false);
			expect(validateEnvelope({ ...envelope, v: 2 }).ok).toBe(false);
			expect(validateEnvelope({ ...envelope, v: "1" }).ok).toBe(false);
		}
	});
});

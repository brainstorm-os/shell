/**
 * END-TO-END Files host service: real manifest → real installer → real
 * ledger → real Broker → real files service. Pins the per-iteration
 * security contract that the broker actually re-checks `files.read` /
 * `files.write` from the live ledger (not the envelope hint), so an app
 * that hasn't declared the cap is denied at the envelope boundary, not
 * inside the handler.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

vi.mock("electron", () => ({
	dialog: { showOpenDialog: () => undefined, showSaveDialog: () => undefined },
}));

import { Broker } from "../../ipc/broker";
import { makeEnvelope } from "../../ipc/envelope";
import { AppInstaller } from "../apps/installer";
import type { AppManifest } from "../apps/manifest";
import { CapabilityLedger } from "../capabilities/ledger";
import { FileHandleMode, FileHandleRegistry } from "../files/file-handle-registry";
import { type StoreUploadAsset, makeFilesServiceHandler } from "../files/files-service";
import { DataStores } from "../storage/data-stores";

import { vi } from "vitest";

const APP_ID = "io.brainstorm.files-it";
const baseManifest = (capabilities: string[]): AppManifest => ({
	id: APP_ID,
	name: "Files-IT",
	version: "0.1.0",
	sdk: "1",
	entry: "dist/index.html",
	capabilities,
	registrations: {},
});

async function setup(capabilities: string[]) {
	const vaultDir = await mkdtemp(join(tmpdir(), "bs-filessvc-"));
	const sourceDir = await mkdtemp(join(tmpdir(), "bs-filessvc-src-"));
	await mkdir(sourceDir, { recursive: true });
	await writeFile(
		join(sourceDir, "manifest.json"),
		JSON.stringify(baseManifest(capabilities)),
		"utf8",
	);
	await mkdir(join(sourceDir, "dist"), { recursive: true });
	await writeFile(join(sourceDir, "dist", "index.html"), "<!doctype html>", "utf8");
	const stores = new DataStores(vaultDir);
	const ledger = new CapabilityLedger(await stores.open("ledger"));
	const installer = new AppInstaller(vaultDir, await stores.open("registry"), ledger);
	const install = await installer.install({ bundleDir: sourceDir });
	expect(install.ok).toBe(true);
	const registry = new FileHandleRegistry();
	return { vaultDir, sourceDir, stores, ledger, registry };
}

function newBroker(
	ledger: CapabilityLedger,
	registry: FileHandleRegistry,
	fsBackend: {
		read: (p: string) => Promise<Buffer>;
		write: (p: string, b: Uint8Array) => Promise<void>;
	},
	storeUploadAsset?: StoreUploadAsset,
) {
	const broker = new Broker({
		services: new Map(),
		verifyAppIdentity: (app) => app === APP_ID,
		checkCapability: (app, _s, _m, caps) => caps.every((c) => ledger.has(app, c)),
	});
	broker.registerService(
		"files",
		makeFilesServiceHandler({
			getRegistry: () => registry,
			showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
			showSaveDialog: async () => ({ canceled: true, filePath: null }),
			emitWatch: () => {},
			readFile: fsBackend.read,
			writeFile: fsBackend.write,
			storeUploadAsset,
		}),
	);
	return broker;
}

describe("files service through the real broker", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
		await rm(env.sourceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	describe("with `files.read` granted at install", () => {
		beforeEach(async () => {
			env = await setup(["files.read"]);
		});

		it("read() round-trips bytes through the broker envelope", async () => {
			const target = join(env.vaultDir, "hello.txt");
			await writeFile(target, "world", "utf8");
			const token = env.registry.mint(APP_ID, target, FileHandleMode.Read);

			const broker = newBroker(env.ledger, env.registry, {
				read: (p) => readFile(p),
				write: async () => undefined,
			});

			const reply = await broker.dispatch(
				makeEnvelope({
					msg: "m1",
					app: APP_ID,
					service: "files",
					method: "read",
					args: [{ handleId: token }],
					caps: ["files.read"],
				}),
				1,
			);
			expect(reply.ok).toBe(true);
			if (reply.ok) {
				const { base64 } = reply.value as { base64: string };
				expect(Buffer.from(base64, "base64").toString("utf8")).toBe("world");
			}
		});

		it("import({handleId}) seals the file's bytes into the asset store and replies with the stored coordinates", async () => {
			const target = join(env.vaultDir, "photo.png");
			const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
			await writeFile(target, content);
			const token = env.registry.mint(APP_ID, target, FileHandleMode.Read);

			const sealed: Array<{ bytes: Uint8Array; mime: string }> = [];
			const broker = newBroker(
				env.ledger,
				env.registry,
				{ read: (p) => readFile(p), write: async () => undefined },
				async (input) => {
					sealed.push(input);
					return { assetId: "asset-1", contentHash: "hash-1" };
				},
			);

			const reply = await broker.dispatch(
				makeEnvelope({
					msg: "mi1",
					app: APP_ID,
					service: "files",
					method: "import",
					args: [{ handleId: token }],
					caps: ["files.read"],
				}),
				1,
			);
			expect(reply.ok).toBe(true);
			if (reply.ok) {
				expect(reply.value).toEqual({
					assetId: "asset-1",
					contentHash: "hash-1",
					size: content.byteLength,
					mime: "image/png",
					name: "photo.png",
				});
			}
			expect(sealed).toHaveLength(1);
			expect(Buffer.from(sealed[0]?.bytes ?? []).equals(content)).toBe(true);
			expect(sealed[0]?.mime).toBe("image/png");
		});

		it("import({name, data}) — the drag-in bytes variant — stores without any handle", async () => {
			const bytes = Buffer.from("dropped content", "utf8");
			const sealed: Array<{ bytes: Uint8Array; mime: string }> = [];
			const broker = newBroker(
				env.ledger,
				env.registry,
				{ read: () => Promise.reject(new Error("no fs read expected")), write: async () => undefined },
				async (input) => {
					sealed.push(input);
					return { assetId: "asset-2", contentHash: "hash-2" };
				},
			);

			const reply = await broker.dispatch(
				makeEnvelope({
					msg: "mi2",
					app: APP_ID,
					service: "files",
					method: "import",
					args: [{ name: "notes.TXT", data: { base64: bytes.toString("base64") } }],
					caps: ["files.read"],
				}),
				1,
			);
			expect(reply.ok).toBe(true);
			if (reply.ok) {
				expect(reply.value).toMatchObject({
					assetId: "asset-2",
					size: bytes.byteLength,
					mime: "text/plain",
					name: "notes.TXT",
				});
			}
			expect(sealed).toHaveLength(1);
		});

		it("import downgrades active content (SVG) to application/octet-stream in the STORED mime", async () => {
			const broker = newBroker(
				env.ledger,
				env.registry,
				{ read: () => Promise.reject(new Error("unused")), write: async () => undefined },
				async (input) => {
					expect(input.mime).toBe("application/octet-stream");
					return { assetId: "asset-3", contentHash: "hash-3" };
				},
			);
			const reply = await broker.dispatch(
				makeEnvelope({
					msg: "mi3",
					app: APP_ID,
					service: "files",
					method: "import",
					args: [{ name: "vector.svg", data: { base64: Buffer.from("<svg/>").toString("base64") } }],
					caps: ["files.read"],
				}),
				1,
			);
			expect(reply.ok).toBe(true);
			if (reply.ok) expect((reply.value as { mime: string }).mime).toBe("application/octet-stream");
		});

		it("import with a forged handle fails closed (Invalid), never touches the store", async () => {
			let stored = 0;
			const broker = newBroker(
				env.ledger,
				env.registry,
				{ read: () => Promise.reject(new Error("unused")), write: async () => undefined },
				async () => {
					stored += 1;
					return { assetId: "x", contentHash: "x" };
				},
			);
			const reply = await broker.dispatch(
				makeEnvelope({
					msg: "mi4",
					app: APP_ID,
					service: "files",
					method: "import",
					args: [{ handleId: "fh_forged" }],
					caps: ["files.read"],
				}),
				1,
			);
			expect(reply.ok).toBe(false);
			expect(stored).toBe(0);
		});

		it("import with no asset store wired is Unavailable (older wire), never a partial store", async () => {
			const broker = newBroker(env.ledger, env.registry, {
				read: () => Promise.reject(new Error("unused")),
				write: async () => undefined,
			});
			const reply = await broker.dispatch(
				makeEnvelope({
					msg: "mi5",
					app: APP_ID,
					service: "files",
					method: "import",
					args: [{ name: "a.txt", data: { base64: Buffer.from("x").toString("base64") } }],
					caps: ["files.read"],
				}),
				1,
			);
			expect(reply.ok).toBe(false);
		});

		it("write() without `files.write` is CapabilityDenied at the broker (NOT a silent path leak)", async () => {
			const target = join(env.vaultDir, "out.txt");
			const token = env.registry.mint(APP_ID, target, FileHandleMode.ReadWrite);

			const broker = newBroker(env.ledger, env.registry, {
				read: () => readFile(target),
				write: (p, b) => writeFile(p, b),
			});

			const reply = await broker.dispatch(
				makeEnvelope({
					msg: "m2",
					app: APP_ID,
					service: "files",
					method: "write",
					args: [
						{
							handleId: token,
							data: { base64: Buffer.from("nope", "utf8").toString("base64") },
						},
					],
					caps: ["files.write"],
				}),
				1,
			);
			expect(reply.ok).toBe(false);
			if (!reply.ok) expect(reply.error.kind).toBe("CapabilityDenied");
		});
	});

	describe("with NEITHER cap granted", () => {
		beforeEach(async () => {
			env = await setup([]);
		});

		it("requestOpen is CapabilityDenied — the picker never runs", async () => {
			let pickerCalled = false;
			const broker = new Broker({
				services: new Map(),
				verifyAppIdentity: (app) => app === APP_ID,
				checkCapability: (app, _s, _m, caps) => caps.every((c) => env.ledger.has(app, c)),
			});
			broker.registerService(
				"files",
				makeFilesServiceHandler({
					getRegistry: () => env.registry,
					showOpenDialog: async () => {
						pickerCalled = true;
						return { canceled: false, filePaths: ["/v/x"] };
					},
					showSaveDialog: async () => ({ canceled: true, filePath: null }),
					emitWatch: () => {},
				}),
			);
			const reply = await broker.dispatch(
				makeEnvelope({
					msg: "m3",
					app: APP_ID,
					service: "files",
					method: "requestOpen",
					args: [{}],
					caps: ["files.read"],
				}),
				1,
			);
			expect(reply.ok).toBe(false);
			if (!reply.ok) expect(reply.error.kind).toBe("CapabilityDenied");
			expect(pickerCalled).toBe(false);
		});

		it("import is CapabilityDenied — the asset store is never reached", async () => {
			let stored = 0;
			const broker = newBroker(
				env.ledger,
				env.registry,
				{ read: () => Promise.reject(new Error("unused")), write: async () => undefined },
				async () => {
					stored += 1;
					return { assetId: "x", contentHash: "x" };
				},
			);
			const reply = await broker.dispatch(
				makeEnvelope({
					msg: "mi6",
					app: APP_ID,
					service: "files",
					method: "import",
					args: [{ name: "a.txt", data: { base64: Buffer.from("x").toString("base64") } }],
					caps: ["files.read"],
				}),
				1,
			);
			expect(reply.ok).toBe(false);
			if (!reply.ok) expect(reply.error.kind).toBe("CapabilityDenied");
			expect(stored).toBe(0);
		});
	});

	describe("with both caps granted", () => {
		beforeEach(async () => {
			env = await setup(["files.read", "files.write"]);
		});

		it("write() persists; round-trip via read()", async () => {
			const target = join(env.vaultDir, "rt.txt");
			const token = env.registry.mint(APP_ID, target, FileHandleMode.ReadWrite);
			const broker = newBroker(env.ledger, env.registry, {
				read: (p) => readFile(p),
				write: (p, b) => writeFile(p, b),
			});

			const writeReply = await broker.dispatch(
				makeEnvelope({
					msg: "w1",
					app: APP_ID,
					service: "files",
					method: "write",
					args: [
						{
							handleId: token,
							data: { base64: Buffer.from("persisted", "utf8").toString("base64") },
						},
					],
					caps: ["files.write"],
				}),
				1,
			);
			expect(writeReply.ok).toBe(true);

			const readReply = await broker.dispatch(
				makeEnvelope({
					msg: "r1",
					app: APP_ID,
					service: "files",
					method: "read",
					args: [{ handleId: token }],
					caps: ["files.read"],
				}),
				1,
			);
			expect(readReply.ok).toBe(true);
			if (readReply.ok) {
				const { base64 } = readReply.value as { base64: string };
				expect(Buffer.from(base64, "base64").toString("utf8")).toBe("persisted");
			}
		});
	});
});

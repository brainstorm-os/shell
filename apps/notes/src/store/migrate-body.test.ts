// @vitest-environment jsdom
/**
 * 9.3.5.N4 — vault-open body migration. Tests pin the three
 * non-negotiables: idempotent (a stamped vault skips the scan,
 * end-to-end), reversible-by-snapshot (`bodyLegacy` is preserved across
 * a successful plant + survives a full re-load), non-destructive
 * (a doc with live content is never clobbered by an old legacy blob).
 *
 * jsdom: `@lexical/yjs`'s React plugin reads `document.activeElement`
 * in mount paths the migration never touches, but `createBinding`
 * itself and `syncLexicalUpdateToYjs` are DOM-free. We pick jsdom so a
 * future change that does reach for the DOM doesn't go silent.
 */

import { getUniversalBody } from "@brainstorm-os/react-yjs";
import type { SerializedEditorState } from "lexical";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Doc, XmlText } from "yjs";
import { parseStoredNote } from "./codec";
import {
	CURRENT_MIGRATION_VERSION,
	MIGRATION_VERSION_KEY,
	MigrationOutcome,
	isLegacyEditorState,
	plantSerializedStateIntoDoc,
	runVaultBodyMigration,
} from "./migrate-body";
import type { StoredNote } from "./note";
import type { NotesRepository } from "./repository";
import type { StorageService } from "./runtime";

function fakeStorage(initial: Record<string, unknown> = {}): {
	storage: Pick<StorageService, "get" | "put">;
	data: Map<string, unknown>;
} {
	const data = new Map<string, unknown>(Object.entries(initial));
	return {
		data,
		storage: {
			get: vi.fn(async (k: string) => (data.get(k) ?? null) as never),
			put: vi.fn(async (k: string, v: unknown) => {
				data.set(k, v);
			}),
		},
	};
}

function fakeRepo(): {
	repo: NotesRepository;
	saves: StoredNote[];
	patches: { id: string; body: string }[];
} {
	const saves: StoredNote[] = [];
	const patches: { id: string; body: string }[] = [];
	const repo: NotesRepository = {
		listAll: async () => new Map(),
		save: async (note) => {
			saves.push(structuredClone(note));
		},
		patchBody: async (id, body) => {
			patches.push({ id, body });
		},
		remove: async () => {},
	};
	return { repo, saves, patches };
}

function fakeResolver() {
	const docs = new Map<string, Doc>();
	let releases = 0;
	return {
		docs,
		releases: () => releases,
		resolve(id: string) {
			let doc = docs.get(id);
			if (!doc) {
				doc = new Doc();
				docs.set(id, doc);
			}
			return {
				doc,
				release: () => {
					releases += 1;
				},
			};
		},
	};
}

/** A minimal pre-N2 legacy body — a parseable SerializedEditorState. */
function legacyBody(text: string): SerializedEditorState {
	return {
		root: {
			children: [
				{
					children: [
						{
							detail: 0,
							format: 0,
							mode: "normal",
							style: "",
							text,
							type: "text",
							version: 1,
						},
					],
					direction: "ltr",
					format: "",
					indent: 0,
					type: "paragraph",
					version: 1,
					textFormat: 0,
					textStyle: "",
				},
			],
			direction: "ltr",
			format: "",
			indent: 0,
			type: "root",
			version: 1,
		},
	} as unknown as SerializedEditorState;
}

function note(over: Partial<StoredNote> = {}): StoredNote {
	return {
		id: over.id ?? "n_test",
		title: over.title ?? "",
		icon: null,
		cover: null,
		body: over.body ?? "",
		values: {},
		createdAt: 1,
		updatedAt: 2,
		...over,
	};
}

describe("isLegacyEditorState", () => {
	it("accepts a structurally valid SerializedEditorState", () => {
		expect(isLegacyEditorState(legacyBody("x"))).toBe(true);
	});
	it("rejects strings, null, primitives, and ill-shaped objects", () => {
		expect(isLegacyEditorState("")).toBe(false);
		expect(isLegacyEditorState(null)).toBe(false);
		expect(isLegacyEditorState({})).toBe(false);
		expect(isLegacyEditorState({ root: {} })).toBe(false);
		expect(isLegacyEditorState({ root: { type: "root" } })).toBe(false);
	});
});

describe("plantSerializedStateIntoDoc", () => {
	it("writes the legacy body's plain text into the universal body root", () => {
		const doc = new Doc();
		plantSerializedStateIntoDoc(doc, legacyBody("hello migration"));
		const body = getUniversalBody(doc);
		expect(body).toBeInstanceOf(XmlText);
		expect(body.length).toBeGreaterThan(0);
		expect(body.toString()).toContain("hello migration");
	});

	it("plants in a single Yjs transaction (one undo step / one update message)", () => {
		const doc = new Doc();
		let updates = 0;
		doc.on("afterTransaction", () => {
			updates += 1;
		});
		plantSerializedStateIntoDoc(doc, legacyBody("one transaction"));
		// The headless editor's setEditorState fans out commits we don't
		// control, but the doc.transact wrapper folds them all into one
		// Yjs transaction — at most one `afterTransaction` event for the
		// caller-driven plant.
		expect(updates).toBe(1);
	});

	it("round-trips through Y.encodeStateAsUpdate (the planted content survives replication)", async () => {
		const writer = new Doc();
		plantSerializedStateIntoDoc(writer, legacyBody("replicate me"));
		const update = (await import("yjs")).encodeStateAsUpdate(writer);
		const reader = new Doc();
		(await import("yjs")).applyUpdate(reader, update);
		expect(getUniversalBody(reader).toString()).toContain("replicate me");
	});
});

describe("runVaultBodyMigration", () => {
	let storage: ReturnType<typeof fakeStorage>;
	let repo: ReturnType<typeof fakeRepo>;
	let resolver: ReturnType<typeof fakeResolver>;

	beforeEach(() => {
		storage = fakeStorage();
		repo = fakeRepo();
		resolver = fakeResolver();
	});

	it("plants legacy bodies into the universal Y.Doc root and writes the snippet onto body", async () => {
		const n = note({ id: "n_legacy", bodyLegacy: legacyBody("planted text here") });
		const notes = new Map([[n.id, n]]);

		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});

		expect(summary.planted).toBe(1);
		expect(summary.scanned).toBe(1);
		expect(summary.fastPath).toBe(false);
		const doc = resolver.docs.get("n_legacy");
		if (!doc) throw new Error("resolver never resolved n_legacy");
		const body = getUniversalBody(doc);
		expect(body.toString()).toContain("planted text here");
		const stored = notes.get("n_legacy");
		expect(stored?.body).toContain("planted text here");
		// bodyLegacy preserved as the rollback escape-hatch.
		expect(stored?.bodyLegacy).toBeDefined();
		// Body-only patch — the migration never round-trips the whole
		// captured note (`save` would clobber concurrent user edits to
		// `values` / `title` / `updatedAt`).
		expect(repo.saves).toHaveLength(0);
		expect(repo.patches).toHaveLength(1);
		expect(repo.patches[0]?.id).toBe("n_legacy");
		expect(repo.patches[0]?.body).toContain("planted text here");
		expect(storage.data.get(MIGRATION_VERSION_KEY)).toBe(CURRENT_MIGRATION_VERSION);
	});

	it("is idempotent — a second run on the stamped vault is a fast-path no-op", async () => {
		const n = note({ id: "n_idem", bodyLegacy: legacyBody("idem text") });
		const notes = new Map([[n.id, n]]);
		await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});
		const patchesAfterFirst = repo.patches.length;
		const releasesAfterFirst = resolver.releases();
		expect(patchesAfterFirst).toBe(1);
		expect(repo.saves).toHaveLength(0);

		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});
		expect(summary.fastPath).toBe(true);
		expect(summary.scanned).toBe(0);
		// No additional patches, no additional doc resolves.
		expect(repo.patches.length).toBe(patchesAfterFirst);
		expect(resolver.releases()).toBe(releasesAfterFirst);
	});

	it("never clobbers a doc that already has content — only refreshes the snippet", async () => {
		const n = note({ id: "n_live", body: "stale snippet", bodyLegacy: legacyBody("ancient legacy") });
		const notes = new Map([[n.id, n]]);
		// Pre-populate the doc with content (simulates an edit on the new
		// path before the migration ran).
		const doc = new Doc();
		doc.get("root", XmlText).insert(0, "fresh user content from the new path");
		resolver.docs.set("n_live", doc);

		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});

		expect(summary.clobberAvoided).toBe(1);
		expect(summary.planted).toBe(0);
		// Doc unchanged: still says the fresh user content, not the legacy
		// text.
		expect(getUniversalBody(doc).toString()).toContain("fresh user content");
		expect(getUniversalBody(doc).toString()).not.toContain("ancient legacy");
		// Snippet refreshed from the live doc; legacy preserved.
		expect(notes.get("n_live")?.body).toContain("fresh user content");
		expect(notes.get("n_live")?.bodyLegacy).toBeDefined();
	});

	it("seeder-owned rows (doc-docs-* / iteration-*) replant from legacy even when the doc has content", async () => {
		// The seeder regenerates these from source on every `seed-cli` run,
		// so the freshly-seeded `bodyLegacy` is the authoritative content —
		// `ClobberAvoided` is the wrong default for them. (The kv→entities
		// backfill carve-out already mirrors this contract on the entities
		// side; the migration is the second half.)
		const docNote = note({
			id: "doc-docs-foundations-00-index",
			body: "stale snippet",
			bodyLegacy: legacyBody("fresh seeded design-doc body"),
		});
		const iterNote = note({
			id: "iteration-9-14-1",
			body: "stale snippet",
			bodyLegacy: legacyBody("fresh seeded iteration body"),
		});
		const userNote = note({
			id: "n_user_alongside",
			body: "stale snippet",
			bodyLegacy: legacyBody("legacy user body"),
		});
		const notes = new Map([
			[docNote.id, docNote],
			[iterNote.id, iterNote],
			[userNote.id, userNote],
		]);

		const docDoc = new Doc();
		docDoc.get("root", XmlText).insert(0, "older seeded doc-doc content");
		resolver.docs.set(docNote.id, docDoc);
		const iterDoc = new Doc();
		iterDoc.get("root", XmlText).insert(0, "older seeded iteration content");
		resolver.docs.set(iterNote.id, iterDoc);
		const userDoc = new Doc();
		userDoc.get("root", XmlText).insert(0, "user edited this");
		resolver.docs.set(userNote.id, userDoc);

		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});

		expect(summary.planted).toBe(2);
		expect(summary.clobberAvoided).toBe(1);

		// Seeder rows now hold the FRESH legacy content, the older replica
		// having been cleared and re-planted in one transaction.
		expect(getUniversalBody(docDoc).toString()).toContain("fresh seeded design-doc body");
		expect(getUniversalBody(docDoc).toString()).not.toContain("older seeded doc-doc content");
		expect(getUniversalBody(iterDoc).toString()).toContain("fresh seeded iteration body");
		expect(getUniversalBody(iterDoc).toString()).not.toContain("older seeded iteration content");

		// The user note alongside them is untouched — the carve-out is
		// strictly id-scoped; `n_*` ids stay on `ClobberAvoided`.
		expect(getUniversalBody(userDoc).toString()).toContain("user edited this");
		expect(getUniversalBody(userDoc).toString()).not.toContain("legacy user body");
	});

	it("repairs a structured-clone-crashed doc: title attached but body sync aborted → re-plant legacy", async () => {
		// The structured-clone-broken preload resolver could plant the
		// TitleNode and then throw before `syncLexicalUpdateToYjs` reached
		// the body children, leaving the .ydoc with `<title>Read me first
		// </title><paragraph></paragraph>` — title text present, every
		// other element empty. `bodyLegacy` still holds the full
		// SerializedEditorState, so the migration can recover.
		const n = note({
			id: "n_corrupt",
			title: "Read me first",
			body: "Welcome to your vault — this is sample data.", // stale snippet
			bodyLegacy: legacyBody("Welcome to your vault — this is sample data."),
		});
		const notes = new Map([[n.id, n]]);
		// Pre-populate the doc to mimic the corruption pattern: a title
		// XmlText carrying the stored title, then a second XmlText (the
		// would-be paragraph) with no children.
		const doc = new Doc();
		const root = doc.get("root", XmlText);
		const titleEl = new XmlText();
		titleEl.setAttribute("__type", "title");
		titleEl.insert(0, "Read me first");
		const paraEl = new XmlText();
		paraEl.setAttribute("__type", "paragraph");
		root.insertEmbed(0, titleEl);
		root.insertEmbed(1, paraEl);
		resolver.docs.set("n_corrupt", doc);

		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});

		expect(summary.planted).toBe(1);
		expect(summary.clobberAvoided).toBe(0);
		const body = getUniversalBody(doc);
		expect(body.toString()).toContain("Welcome to your vault");
		// Title is still there exactly once — `migrateTitleIntoBody`
		// re-prepends it as part of the re-plant; the corruption wipe
		// drops the stub-only copy first so we don't double up.
		const titleOccurrences = (body.toString().match(/Read me first/g) ?? []).length;
		expect(titleOccurrences).toBe(1);
	});

	it("leaves a doc with real inline text alone even if it looks structurally minimal", async () => {
		// Defence: a tiny but real edit ("ok" in the paragraph) must not
		// be misclassified as the corruption pattern — the repair branch
		// only kicks in when the doc contains exactly the stored title
		// and nothing else.
		const n = note({
			id: "n_tiny",
			title: "Read me first",
			body: "stale snippet",
			bodyLegacy: legacyBody("ancient legacy"),
		});
		const notes = new Map([[n.id, n]]);
		const doc = new Doc();
		const root = doc.get("root", XmlText);
		const titleEl = new XmlText();
		titleEl.setAttribute("__type", "title");
		titleEl.insert(0, "Read me first");
		const paraEl = new XmlText();
		paraEl.setAttribute("__type", "paragraph");
		paraEl.insert(0, "ok"); // real user content, however small
		root.insertEmbed(0, titleEl);
		root.insertEmbed(1, paraEl);
		resolver.docs.set("n_tiny", doc);

		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});

		expect(summary.clobberAvoided).toBe(1);
		expect(summary.planted).toBe(0);
		expect(getUniversalBody(doc).toString()).toContain("ok");
		expect(getUniversalBody(doc).toString()).not.toContain("ancient legacy");
	});

	it("computes a snippet for cold-cache rows whose doc has content but body is empty", async () => {
		const n = note({ id: "n_cold", body: "" });
		const notes = new Map([[n.id, n]]);
		const doc = new Doc();
		doc.get("root", XmlText).insert(0, "cold doc content needs snippet");
		resolver.docs.set("n_cold", doc);

		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});

		expect(summary.snippetOnly).toBe(1);
		expect(notes.get("n_cold")?.body).toContain("cold doc content needs snippet");
	});

	it("skips an already-current note (string body, no legacy, empty doc)", async () => {
		const n = note({ id: "n_current", body: "" });
		const notes = new Map([[n.id, n]]);

		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});

		expect(summary.skipped).toBe(1);
		expect(summary.planted).toBe(0);
		expect(repo.saves).toHaveLength(0);
		expect(storage.data.get(MIGRATION_VERSION_KEY)).toBe(CURRENT_MIGRATION_VERSION);
	});

	it("isolates per-note failures — a bad note doesn't take down the vault", async () => {
		const ok = note({ id: "n_ok", bodyLegacy: legacyBody("ok body") });
		const bad = note({
			id: "n_bad",
			bodyLegacy: {
				root: { type: "root", children: [{ type: "unknown-node-type", version: 1 }] },
			} as unknown as SerializedEditorState,
		});
		const notes = new Map([
			[ok.id, ok],
			[bad.id, bad],
		]);
		const onError = vi.fn();

		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
			onError,
		});

		expect(summary.planted).toBe(1);
		expect(summary.failed).toBe(1);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[0]).toBe(bad);
		// Still stamps the vault — we don't retry forever on the bad
		// note; the user recovers via bodyLegacy + a stamp clear.
		expect(storage.data.get(MIGRATION_VERSION_KEY)).toBe(CURRENT_MIGRATION_VERSION);
	});

	it("does NOT stamp when failures are transient (cap-ledger race / Denied) — retry on next boot", async () => {
		// Reproduces the 2026-05-22 incident: the dev-seeder reinstall
		// race revoked `entities.write` while the migration was running;
		// every note failed with `Denied`; the stamp landed anyway and
		// titles/content disappeared across the vault because the next
		// boot fast-pathed past the (now-recoverable) migration. The
		// stamp MUST NOT land when the failures are environmental.
		const a = note({ id: "n_a", bodyLegacy: legacyBody("a") });
		const b = note({ id: "n_b", bodyLegacy: legacyBody("b") });
		const notes = new Map([
			[a.id, a],
			[b.id, b],
		]);
		const denied = new Error("entities.applyDoc: no entities.write for Note/v1");
		denied.name = "Denied";
		const failingRepo: NotesRepository = {
			listAll: async () => new Map(),
			save: async () => {
				throw denied;
			},
			patchBody: async () => {
				throw denied;
			},
			remove: async () => {},
		};
		const onError = vi.fn();

		const summary = await runVaultBodyMigration({
			notes,
			repo: failingRepo,
			resolve: resolver.resolve,
			storage: storage.storage,
			onError,
		});

		expect(summary.failed).toBe(2);
		expect(onError).toHaveBeenCalledTimes(2);
		// Stamp NOT written — the next boot retries once caps are
		// restored.
		expect(storage.data.get(MIGRATION_VERSION_KEY)).toBeUndefined();
	});

	it("still stamps when SOME notes fail transiently but the rest succeed (the per-note error path)", async () => {
		// A `Denied` on one note doesn't condemn the whole vault — only
		// when EVERY failure looks transient do we hold the stamp.
		const ok = note({ id: "n_ok", bodyLegacy: legacyBody("ok") });
		const fail = note({ id: "n_fail", bodyLegacy: legacyBody("nope") });
		const notes = new Map([
			[ok.id, ok],
			[fail.id, fail],
		]);
		const malformed = new Error("plant: unknown node type");
		const partiallyFailingRepo: NotesRepository = {
			listAll: async () => new Map(),
			save: async (n) => {
				if (n.id === "n_fail") throw malformed;
				repo.saves.push(structuredClone(n));
			},
			patchBody: async (id, body) => {
				if (id === "n_fail") throw malformed;
				repo.patches.push({ id, body });
			},
			remove: async () => {},
		};

		const summary = await runVaultBodyMigration({
			notes,
			repo: partiallyFailingRepo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});

		expect(summary.planted).toBe(1);
		expect(summary.failed).toBe(1);
		// The per-note failure isn't transient → stamp lands; the user
		// recovers the bad note via its `bodyLegacy`.
		expect(storage.data.get(MIGRATION_VERSION_KEY)).toBe(CURRENT_MIGRATION_VERSION);
	});

	it("does NOT stamp on an empty scan — a brand-new vault must NOT lock out a later reseed", async () => {
		// Reproduces the 2026-05-22 bug: first boot of a fresh vault has
		// zero notes, the migration scans nothing, stamps the version, and
		// when the user later runs `dev:reseed-vault` (which writes 495
		// notes into entities.db AFTER Notes has booted), the migration
		// fast-paths past them on the next launch — Y.Docs stay empty and
		// the editor renders just the icon. The fix is to stamp only when
		// there was actual work to scan; on the empty boot we leave the
		// stamp absent so the next boot retries with the freshly seeded
		// content.
		const empty = new Map<string, StoredNote>();

		const summary = await runVaultBodyMigration({
			notes: empty,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});

		expect(summary.scanned).toBe(0);
		expect(summary.failed).toBe(0);
		expect(storage.data.get(MIGRATION_VERSION_KEY)).toBeUndefined();
	});

	it("classifies an unparseable string legacy as Failed (still recoverable via bodyLegacy)", async () => {
		const n = note({
			id: "n_str",
			bodyLegacy: "this used to be a raw string body",
		});
		const notes = new Map([[n.id, n]]);

		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});

		expect(summary.failed).toBe(1);
		expect(summary.planted).toBe(0);
		// Legacy still there for recovery.
		expect(notes.get("n_str")?.bodyLegacy).toBe("this used to be a raw string body");
	});

	it("a re-decoded migrated note from the codec retains its bodyLegacy (the rollback path round-trips)", async () => {
		const legacy = legacyBody("rollback survivor");
		const n = note({ id: "n_rt", bodyLegacy: legacy });
		const notes = new Map([[n.id, n]]);
		await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});
		// The migration patched body server-side and mutated the captured
		// note in place — pretend the vault is reloaded: the codec decodes
		// the mutated note shape (the in-memory and on-disk shapes match
		// because the body-only patch merges into the existing row).
		const reread = parseStoredNote(notes.get("n_rt"));
		expect(reread?.body).toContain("rollback survivor");
		expect(reread?.bodyLegacy).toBeDefined();
	});

	it("releases every doc handle it resolves (no leaked refcounts on the resolver)", async () => {
		const a = note({ id: "n_a", bodyLegacy: legacyBody("aaa") });
		const b = note({ id: "n_b", body: "" });
		const notes = new Map([
			[a.id, a],
			[b.id, b],
		]);

		await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});

		expect(resolver.releases()).toBe(2);
	});

	it("does not clobber a concurrent user edit to a note's values/updatedAt (body-only patch)", async () => {
		// Regression fence for the iteration-bundle (d2bae00) bug:
		// `runVaultBodyMigration` used to round-trip the whole captured note
		// via `repo.save`. Because the migration captures references at
		// boot and now runs in the background AFTER `setReady(true)`, a
		// user edit landing between boot and "migration walks this note"
		// would be silently overwritten — title/icon/values/updatedAt all
		// reverting to the boot snapshot. The fix moves the migration to a
		// body-only `repo.patchBody` so the entities service merges only
		// the body field on disk; concurrent edits to every other field
		// survive untouched.
		const boot: StoredNote = {
			id: "n_concurrent",
			title: "Original",
			icon: null,
			cover: null,
			body: "",
			bodyLegacy: legacyBody("legacy body needs planting"),
			values: {},
			createdAt: 1000,
			updatedAt: 1000,
		};
		// Real merge: the entities service replaces only the patched
		// fields. Disk seeded with the boot row; the assertion below
		// simulates a user edit landing BEFORE the migration walks the
		// row, then asserts the migration didn't undo it.
		const disk = new Map<string, StoredNote>([[boot.id, structuredClone(boot)]]);
		const mergingRepo: NotesRepository = {
			listAll: async () => new Map(disk),
			save: async (n) => {
				disk.set(n.id, structuredClone(n));
			},
			patchBody: async (id, body) => {
				const existing = disk.get(id);
				if (!existing) return;
				disk.set(id, { ...existing, body });
			},
			remove: async (id) => {
				disk.delete(id);
			},
		};

		// User edit lands first (sets a property value, bumps updatedAt) —
		// the migration is still waiting on the per-note Y.Doc handle.
		const userEdited: StoredNote = {
			...structuredClone(boot),
			values: { someKey: "x" } as unknown as StoredNote["values"],
			updatedAt: 2000,
		};
		// biome-ignore lint/performance/noDelete: codec distinguishes absent bodyLegacy from one set to undefined — must be genuinely removed
		delete userEdited.bodyLegacy;
		disk.set(userEdited.id, userEdited);

		// Migration runs with the BOOT-captured reference (stale by now).
		await runVaultBodyMigration({
			notes: new Map([[boot.id, boot]]),
			repo: mergingRepo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});

		const persisted = disk.get(boot.id);
		if (!persisted) throw new Error("disk row vanished");
		// User's concurrent edit is preserved end-to-end.
		expect(persisted.values).toEqual({ someKey: "x" });
		expect(persisted.updatedAt).toBe(2000);
		// And the migration's body patch landed.
		expect(persisted.body).toContain("legacy body needs planting");
	});

	it("Planted outcome bumps tally correctly across multiple notes", async () => {
		const notes = new Map<string, StoredNote>();
		for (let i = 0; i < 5; i++) {
			const n = note({ id: `n_${i}`, bodyLegacy: legacyBody(`body ${i}`) });
			notes.set(n.id, n);
		}
		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
		});
		expect(summary.planted).toBe(5);
		expect(summary.scanned).toBe(5);
	});

	it("MigrationOutcome enum covers every per-note tally bucket", () => {
		// Compile-time pin: a new bucket without a corresponding outcome
		// would break the switch in countOutcome.
		expect(Object.values(MigrationOutcome).sort()).toEqual(
			["clobber-avoided", "failed", "planted", "skipped", "snippet-only"].sort(),
		);
	});

	it("never calls repo.save on a note whose plant threw (the legacy blob stays on disk untouched)", async () => {
		// Regression fence for the should-fix from N4's code review: a
		// throw inside plantSerializedStateIntoDoc is caught by the outer
		// runVaultBodyMigration try/catch and counts as Failed — but it
		// MUST NOT have reached the per-note `repo.save`, otherwise a
		// partially-mutated row could land on disk while the body sits
		// unparsed in the Y.Doc.
		const ok = note({ id: "n_ok2", bodyLegacy: legacyBody("ok body") });
		const bad = note({
			id: "n_bad2",
			bodyLegacy: {
				root: { type: "root", children: [{ type: "unknown-node-type", version: 1 }] },
			} as unknown as SerializedEditorState,
		});
		const notes = new Map([
			[ok.id, ok],
			[bad.id, bad],
		]);

		await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
			onError: () => {},
		});

		// One body patch (for the OK note), none for the failed one.
		expect(repo.saves).toHaveLength(0);
		expect(repo.patches).toHaveLength(1);
		expect(repo.patches[0]?.id).toBe("n_ok2");
		expect(repo.patches.some((p) => p.id === "n_bad2")).toBe(false);
	});

	it("awaits `whenLoaded(id)` before reading docEmpty — clobber-safety on a hydrating real-resolver", async () => {
		// REGRESSION FENCE for the perf-review BLOCKER on N4:
		// the production resolver's `load()` is async, so `resolve()`
		// returns an empty doc that hydrates later via
		// `Y.applyUpdate(doc, snapshot, REMOTE_ORIGIN)`. Without awaiting
		// `whenLoaded(id)`, the migration would read `body.length === 0`
		// on the unhydrated replica and plant legacy content on top —
		// silently mixing legacy with canonical content once the snapshot
		// lands. This test models that race: the fake's `whenLoaded`
		// applies a snapshot to the doc only when awaited.
		const n = note({ id: "n_hydrating", bodyLegacy: legacyBody("ancient legacy") });
		const notes = new Map([[n.id, n]]);

		const hydratingDocs = new Map<string, Doc>();
		let releases = 0;
		const hydratingResolver: typeof resolver = {
			docs: hydratingDocs,
			releases: () => releases,
			resolve: (id: string) => {
				let doc = hydratingDocs.get(id);
				if (!doc) {
					doc = new Doc();
					hydratingDocs.set(id, doc);
				}
				return {
					doc,
					release: () => {
						releases += 1;
					},
				};
			},
		};
		const whenLoaded = async (id: string): Promise<void> => {
			const doc = hydratingDocs.get(id);
			if (!doc) return;
			// Simulate the canonical snapshot arriving asynchronously —
			// the doc was empty when `resolve()` returned, and only after
			// `whenLoaded` resolves does it carry content.
			doc.get("root", XmlText).insert(0, "canonical content from the snapshot");
		};

		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: hydratingResolver.resolve,
			whenLoaded,
			storage: storage.storage,
		});

		// With the await: the doc is non-empty when read, so the migration
		// goes through ClobberAvoided (refresh snippet, leave doc alone).
		// Without the await (the bug), it would have planted "ancient
		// legacy" on top of "canonical content".
		expect(summary.clobberAvoided).toBe(1);
		expect(summary.planted).toBe(0);
		const doc = hydratingDocs.get("n_hydrating");
		if (!doc) throw new Error("resolver never resolved n_hydrating");
		// Doc still has only the canonical content — legacy never reached it.
		expect(getUniversalBody(doc).toString()).toContain("canonical content");
		expect(getUniversalBody(doc).toString()).not.toContain("ancient legacy");
		// Snippet reflects the live (canonical) doc.
		expect(notes.get("n_hydrating")?.body).toContain("canonical content");
		// Rollback target preserved.
		expect(notes.get("n_hydrating")?.bodyLegacy).toBeDefined();
	});

	it("works with no `whenLoaded` (older shells / preview drop) — resolver treated as synchronous", async () => {
		// The whenLoaded prop is optional; when absent the migration uses
		// the doc state as resolved() returned it. This is correct when
		// the resolver IS synchronous (older shells / preview drop /
		// tests with the default fakeResolver). The pre-blocker tests all
		// run this path implicitly; this one pins it explicitly.
		const n = note({ id: "n_no_when", bodyLegacy: legacyBody("plant me") });
		const notes = new Map([[n.id, n]]);
		const summary = await runVaultBodyMigration({
			notes,
			repo: repo.repo,
			resolve: resolver.resolve,
			storage: storage.storage,
			// no whenLoaded
		});
		expect(summary.planted).toBe(1);
	});
});

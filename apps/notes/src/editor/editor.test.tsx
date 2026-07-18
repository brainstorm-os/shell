// @vitest-environment jsdom
/**
 * Editor (9.3.5.N2) — the Yjs-bound surface IS the editor (the legacy
 * storage-blob composer + transport flag were dropped in N2). Tests pin
 * the universal-body wiring + the on-disk MentionNode protocol that
 * cross-app links depend on ([[feedback_mention_persisted_protocol]]).
 *
 * Composition:
 *   - `useYDoc(noteId)` from `@brainstorm/react-yjs` (resolver-backed
 *     entity→doc lookup);
 *   - `useUniversalBody(doc)` from the 9.3.5.B/N2 universal-body
 *     keystone — the `Y.XmlText` named `"root"` (the well-known name
 *     `@lexical/yjs`'s `createBinding` binds to);
 *   - `<BrainstormEditor>` from `@brainstorm/editor` (the `@lexical/yjs`
 *     binding wrapper).
 */

import { BASELINE_NODES, SEED_STANDIN_NODES, plantSerializedStateIntoDoc } from "@brainstorm/editor";
import { YDocProvider, createYDocResolver, getUniversalBody } from "@brainstorm/react-yjs";
import { REDO_COMMAND, UNDO_COMMAND } from "lexical";
import { type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Doc, XmlText, applyUpdate, encodeStateAsUpdate } from "yjs";
import { Editor } from "./editor";
import type { SerializedMentionNode } from "./nodes/mention-node";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Resolver wrapper that records the resolver-minted doc per id (so the
// test can introspect Lexical's binding root after collab bootstrap).
// Two `<Editor>` mounts on the same id resolve to the SAME doc via the
// resolver's refcount path — Lexical binds two CollabBindings over one
// CRDT. No transport persistence (load returns nothing).
function inMemoryResolver() {
	const docs = new Map<string, Doc>();
	const api = createYDocResolver({
		load: async () => null,
		persist: () => {},
		release: () => {},
	});
	const wrappedResolve: typeof api.resolve = (id) => {
		const handle = api.resolve(id);
		docs.set(id, handle.doc);
		return handle;
	};
	return { resolve: wrappedResolve, docs, dispose: api.dispose };
}

function noteContext() {
	return { values: {}, setValue: () => {} };
}

function mount(node: ReactNode) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	return {
		container,
		render: async (n: ReactNode = node) => {
			await act(async () => {
				root.render(n);
			});
			// Local provider emits sync(true) on the next microtask; the
			// collaboration plugin's bootstrap then runs.
			await act(async () => {
				await Promise.resolve();
			});
		},
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

describe("<Editor>", () => {
	let resolver: ReturnType<typeof inMemoryResolver>;

	beforeEach(() => {
		resolver = inMemoryResolver();
	});
	afterEach(() => {
		resolver.dispose();
	});

	it("mounts a contenteditable and binds Lexical to the entity's Y.Doc through the resolver", async () => {
		const noteId = "n_test_1";
		const surface = mount(null);
		await surface.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor noteId={noteId} storedTitle="" onChange={() => {}} noteContext={noteContext()} />
			</YDocProvider>,
		);

		const editable = surface.container.querySelector('[contenteditable="true"]');
		expect(editable).not.toBeNull();

		// The resolver minted a doc for this id; Lexical's `@lexical/yjs`
		// binding bootstrapped its root XmlText inside it — the same root
		// the universal-body helper resolves.
		const doc = resolver.docs.get(noteId);
		expect(doc).toBeDefined();
		expect(doc?.share.has("root")).toBe(true);
		if (!doc) return;
		const body = getUniversalBody(doc);
		expect(body).toBeInstanceOf(XmlText);
		expect(doc.get("root", XmlText)).toBe(body);

		await surface.unmount();
	});

	it("two mounts on the same noteId share a doc — CRDT convergence holds across instances", async () => {
		// Two `<Editor>` instances against the same resolver + id resolve
		// to the SAME `Y.Doc` (refcounted). Lexical mounts one CollabBinding
		// per editor instance over the same doc, so edits commit through
		// the CRDT once and re-paint in both. The test asserts the doc
		// identity + that the second mount also has a contenteditable.
		const noteId = "n_test_shared";
		const tree = (
			<YDocProvider resolver={resolver.resolve}>
				<div>
					<Editor noteId={noteId} storedTitle="" onChange={() => {}} noteContext={noteContext()} />
					<Editor noteId={noteId} storedTitle="" onChange={() => {}} noteContext={noteContext()} />
				</div>
			</YDocProvider>
		);

		const surface = mount(tree);
		await surface.render();

		const editables = surface.container.querySelectorAll('[contenteditable="true"]');
		expect(editables.length).toBe(2);
		// Both surfaces resolved through the same id; the resolver holds a
		// single doc entry (refcount=2). Lexical's root XmlText is the
		// shared CRDT under both bindings.
		expect(resolver.docs.has(noteId)).toBe(true);
		const doc = resolver.docs.get(noteId);
		expect(doc?.share.has("root")).toBe(true);

		await surface.unmount();
	});

	it("the universal body root is the @lexical/yjs binding root — no parallel `body`/XmlFragment", async () => {
		// 9.3.5.N2 reconciled 9.3.5.B's `body`/XmlFragment naming with the
		// `@lexical/yjs` `root`/XmlText shape. The universal body now IS
		// the editor's root; there's no parallel empty fragment any more.
		const noteId = "n_test_root";
		const surface = mount(null);
		await surface.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor noteId={noteId} storedTitle="" onChange={() => {}} noteContext={noteContext()} />
			</YDocProvider>,
		);

		const doc = resolver.docs.get(noteId);
		expect(doc).toBeDefined();
		if (!doc) return;
		// Only one root type is registered under the well-known name.
		expect(doc.share.has("root")).toBe(true);
		// And it's an XmlText, the @lexical/yjs binding shape.
		expect(getUniversalBody(doc)).toBeInstanceOf(XmlText);
		// No competing "body" root from the prior contract.
		expect(doc.share.has("body")).toBe(false);

		await surface.unmount();
	});

	it("the universal body is actually written to — Lexical's bootstrap fills the same root the helper resolves", async () => {
		// N2 ships the body-primary data model: the universal body IS the
		// editor's CRDT root. After bootstrap, the body's XmlText has real
		// content (paragraphs / linebreaks from `@lexical/yjs`'s seeding),
		// not the empty handle the prior N1 path produced.
		const noteId = "n_test_body_filled";
		const surface = mount(null);
		await surface.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor noteId={noteId} storedTitle="" onChange={() => {}} noteContext={noteContext()} />
			</YDocProvider>,
		);

		const doc = resolver.docs.get(noteId);
		expect(doc).toBeDefined();
		if (!doc) return;
		const body = getUniversalBody(doc);
		// Bootstrap inserted at least the root paragraph; the in-memory
		// XmlText length tracks character + element insertions, so it's
		// strictly > 0 once the editor has mounted.
		expect(body.length).toBeGreaterThan(0);

		await surface.unmount();
	});

	it("body survives a Y.Doc round-trip (encodeStateAsUpdate → fresh doc → same XmlText snapshot)", async () => {
		// The point of moving the body into the Y.Doc is durable
		// transport: encoded updates round-trip onto a fresh replica. This
		// pins the CRDT path end-to-end through the editor (bootstrap +
		// `@lexical/yjs` binding produce the encoded state, NOT the test).
		const Y = await import("yjs");
		const noteId = "n_test_roundtrip";
		const surface = mount(null);
		await surface.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor noteId={noteId} storedTitle="" onChange={() => {}} noteContext={noteContext()} />
			</YDocProvider>,
		);

		const writer = resolver.docs.get(noteId);
		expect(writer).toBeDefined();
		if (!writer) return;

		const update = Y.encodeStateAsUpdate(writer);
		const reader = new Y.Doc();
		Y.applyUpdate(reader, update);

		const writerBody = getUniversalBody(writer);
		const readerBody = getUniversalBody(reader);
		expect(readerBody.toString()).toBe(writerBody.toString());
		expect(readerBody.length).toBe(writerBody.length);

		await surface.unmount();
	});

	it("bootstrap populates the shared root — Lexical's document materialises inside the resolver-minted doc", async () => {
		// End-to-end smoke: after `@lexical/yjs`'s `shouldBootstrap` runs,
		// the editor produces encoded CRDT state inside the shared `root`
		// (Yjs writes ops as Lexical seeds paragraphs + linebreaks). The
		// resolver-minted doc is exactly the one Lexical bound to — a
		// different doc would have left the resolver's empty.
		const noteId = "n_test_bootstrap";
		const surface = mount(null);
		await surface.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor noteId={noteId} storedTitle="" onChange={() => {}} noteContext={noteContext()} />
			</YDocProvider>,
		);

		const doc = resolver.docs.get(noteId);
		expect(doc).toBeDefined();
		if (!doc) return;

		expect(doc.share.has("root")).toBe(true);
		const root = doc.get("root", XmlText);
		expect(root).toBeInstanceOf(XmlText);

		await surface.unmount();
	});
});

describe("MentionNode persisted-shape protocol (load-bearing for the Yjs transport)", () => {
	// The on-disk JSON shape of MentionNode is the protocol the shell-side
	// cross-app body walker reads to emit `VaultLink[]`. The N2 transport
	// swap moves the body from the kv silo into the Y.Doc but does NOT
	// touch this shape — `exportJSON`/`importJSON` field names are pinned
	// here against accidental drift ([[feedback_mention_persisted_protocol]]).
	it("exportJSON ↔ importJSON round-trips the wire fields verbatim under the new transport", async () => {
		const { createHeadlessEditor } = await import("@lexical/headless");
		const { $createMentionNode, MentionNode } = await import("./nodes/mention-node");

		const editor = createHeadlessEditor({
			nodes: [MentionNode],
			onError(e) {
				throw e;
			},
		});

		let json!: SerializedMentionNode;
		editor.update(
			() => {
				const node = $createMentionNode("ent_abc", "io.brainstorm.notes/Note/v1", "Round trip");
				json = node.exportJSON();
			},
			{ discrete: true },
		);

		expect(json.type).toBe(MentionNode.getType());
		expect(json.entityId).toBe("ent_abc");
		expect(json.entityType).toBe("io.brainstorm.notes/Note/v1");
		expect(json.label).toBe("Round trip");

		let roundJson!: SerializedMentionNode;
		editor.update(
			() => {
				const round = MentionNode.importJSON(json);
				roundJson = round.exportJSON();
			},
			{ discrete: true },
		);
		expect(roundJson).toEqual(json);
	});
});

describe("Editor (N3) — title seeding via shouldBootstrap-compatible initializer", () => {
	let resolver: ReturnType<typeof inMemoryResolver>;

	beforeEach(() => {
		resolver = inMemoryResolver();
	});
	afterEach(() => {
		resolver.dispose();
	});

	it("seeds the Y.Doc with a TitleNode bearing the storedTitle on the first attach", async () => {
		const noteId = "n_test_seed_once";
		const surface = mount(null);
		await surface.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor
					noteId={noteId}
					storedTitle="Hello universe"
					onChange={() => {}}
					noteContext={noteContext()}
				/>
			</YDocProvider>,
		);

		const doc = resolver.docs.get(noteId);
		expect(doc).toBeDefined();
		if (!doc) return;
		const body = getUniversalBody(doc);
		expect(body.toString()).toContain("Hello universe");

		await surface.unmount();
	});

	it("does NOT re-seed when a fresh `<Editor>` opens an already-bootstrapped doc (remote-replica idempotency)", async () => {
		// Models the "second client opens an already-seeded doc" path: a
		// fresh resolver hands us a Y.Doc, the first `<Editor>` seeds it,
		// then we sync those encoded updates into a SECOND resolver's
		// fresh doc and mount a second `<Editor>` there. The bootstrap
		// gate (`root._xmlText._length === 0`) is structurally false on
		// the second doc, so the seeder runs zero times.
		const noteId = "n_seeded_first";
		const surface1 = mount(null);
		await surface1.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor
					noteId={noteId}
					storedTitle="Once and only once"
					onChange={() => {}}
					noteContext={noteContext()}
				/>
			</YDocProvider>,
		);
		const writerDoc = resolver.docs.get(noteId);
		expect(writerDoc).toBeDefined();
		if (!writerDoc) return;
		expect(getUniversalBody(writerDoc).toString()).toContain("Once and only once");
		const encoded = (await import("yjs")).encodeStateAsUpdate(writerDoc);
		await surface1.unmount();

		const replicaResolver = inMemoryResolver();
		try {
			const replicaSurface = mount(null);
			// Pre-apply the encoded state to the replica BEFORE the editor
			// mounts so the @lexical/yjs bootstrap gate sees a non-empty
			// root and skips its initializer.
			let preApplied = false;
			const seededResolver: typeof replicaResolver.resolve = (id) => {
				const handle = replicaResolver.resolve(id);
				if (!preApplied) {
					(applyUpdate as (d: Doc, u: Uint8Array) => void)(handle.doc, encoded);
					preApplied = true;
				}
				return handle;
			};

			await replicaSurface.render(
				<YDocProvider resolver={seededResolver}>
					<Editor
						noteId={noteId}
						storedTitle="Once and only once"
						onChange={() => {}}
						noteContext={noteContext()}
					/>
				</YDocProvider>,
			);

			const replicaDoc = replicaResolver.docs.get(noteId);
			expect(replicaDoc).toBeDefined();
			if (!replicaDoc) return;
			const body = getUniversalBody(replicaDoc);
			expect(body.toString().split("Once and only once").length - 1).toBe(1);

			await replicaSurface.unmount();
		} finally {
			replicaResolver.dispose();
		}
	});

	it("does NOT duplicate the title when load resolves after bootstrap (async-load race)", async () => {
		// Production race: the resolver returns an empty Y.Doc immediately and
		// hydrates from the on-disk snapshot asynchronously (IPC). The local
		// provider fires `sync(true)` on the next microtask, so the
		// CollaborationPlugin bootstrap may run BEFORE the snapshot lands. If
		// the seeder writes its TitleNode into the still-empty doc, the
		// snapshot's TitleNode is then merged in via `Y.applyUpdate` and the
		// CRDT keeps BOTH inserts → the body ends up with two titles.
		//
		// This pins the contract: the editor must end up with EXACTLY ONE
		// occurrence of the title text, regardless of load timing.
		const Y = await import("yjs");
		// Build a snapshot the disk would hold: one TitleNode("Real Title")
		// + an empty paragraph. We use a sibling resolver to seed it.
		const seedResolver = inMemoryResolver();
		try {
			const seedSurface = mount(null);
			await seedSurface.render(
				<YDocProvider resolver={seedResolver.resolve}>
					<Editor
						noteId="n_seed"
						storedTitle="Real Title"
						onChange={() => {}}
						noteContext={noteContext()}
					/>
				</YDocProvider>,
			);
			const seedDoc = seedResolver.docs.get("n_seed");
			expect(seedDoc).toBeDefined();
			if (!seedDoc) return;
			const encoded = Y.encodeStateAsUpdate(seedDoc);
			await seedSurface.unmount();

			// Second resolver: `load` returns the encoded snapshot after a
			// macrotask so the local provider's `sync(true)` microtask fires
			// FIRST and the bootstrap seeder runs against the still-empty doc.
			const raceDocs = new Map<string, Doc>();
			const api = createYDocResolver({
				load: async () => {
					await new Promise<void>((resolve) => setTimeout(resolve, 5));
					return encoded;
				},
				persist: () => {},
				release: () => {},
			});
			const wrappedResolve: typeof api.resolve = (id) => {
				const handle = api.resolve(id);
				raceDocs.set(id, handle.doc);
				return handle;
			};

			const raceSurface = mount(null);
			await raceSurface.render(
				<YDocProvider resolver={wrappedResolve}>
					<Editor
						noteId="n_race"
						storedTitle="Real Title"
						onChange={() => {}}
						noteContext={noteContext()}
					/>
				</YDocProvider>,
			);
			// Wait past the deferred load + Lexical reconciliation.
			await act(async () => {
				await new Promise<void>((r) => setTimeout(r, 25));
			});

			const doc = raceDocs.get("n_race");
			expect(doc).toBeDefined();
			if (!doc) return;
			const body = getUniversalBody(doc);
			const flat = body.toString();
			// EXACTLY one occurrence of the title text. Two would mean the
			// seeder + the snapshot both planted the title and the CRDT
			// merge interleaved them.
			expect(flat.split("Real Title").length - 1).toBe(1);

			await raceSurface.unmount();
			api.dispose();
		} finally {
			seedResolver.dispose();
		}
	});

	it("opens an async-loaded existing note with no extra empty TitleNode prefixing the real content", async () => {
		// Companion to the duplicate-title test: even when the caller passes
		// an EMPTY `storedTitle` (the denorm got cleared, or a sibling app
		// dispatched `intent.open` before the title backfilled), the doc
		// must still end up with EXACTLY ONE TitleNode — the one from the
		// snapshot. A pre-bootstrap seeder would have planted an extra empty
		// TitleNode at root[0] and the real one would have been pushed down
		// into the body, leaving the user looking at a blank header.
		const Y = await import("yjs");
		const seedResolver = inMemoryResolver();
		try {
			const seedSurface = mount(null);
			await seedSurface.render(
				<YDocProvider resolver={seedResolver.resolve}>
					<Editor
						noteId="n_seed_implicit"
						storedTitle="Snapshot Title"
						onChange={() => {}}
						noteContext={noteContext()}
					/>
				</YDocProvider>,
			);
			const seedDoc = seedResolver.docs.get("n_seed_implicit");
			expect(seedDoc).toBeDefined();
			if (!seedDoc) return;
			const encoded = Y.encodeStateAsUpdate(seedDoc);
			await seedSurface.unmount();

			const raceDocs = new Map<string, Doc>();
			const api = createYDocResolver({
				load: async () => {
					await new Promise<void>((resolve) => setTimeout(resolve, 5));
					return encoded;
				},
				persist: () => {},
				release: () => {},
			});
			const wrappedResolve: typeof api.resolve = (id) => {
				const handle = api.resolve(id);
				raceDocs.set(id, handle.doc);
				return handle;
			};

			const raceSurface = mount(null);
			await raceSurface.render(
				<YDocProvider resolver={wrappedResolve}>
					<Editor
						noteId="n_race_empty_stored"
						storedTitle=""
						onChange={() => {}}
						noteContext={noteContext()}
					/>
				</YDocProvider>,
			);
			await act(async () => {
				await new Promise<void>((r) => setTimeout(r, 25));
			});

			const doc = raceDocs.get("n_race_empty_stored");
			expect(doc).toBeDefined();
			if (!doc) return;
			const body = getUniversalBody(doc);
			// Text content holds the snapshot title exactly once.
			expect(body.toString()).toContain("Snapshot Title");
			expect(body.toString().split("Snapshot Title").length - 1).toBe(1);
			// Structural assertion — the bug shows up as an EMPTY seeded
			// TitleNode prefixing the snapshot's real TitleNode (the seeder
			// runs with `storedTitle=""` so the empty title carries no
			// inline text and a text-count check would NOT catch it). Walk
			// the body's top-level XmlText children and count those whose
			// node-type attribute is "title". Must be exactly one.
			let titleCount = 0;
			const delta = body.toDelta() as ReadonlyArray<{ insert?: unknown }>;
			for (const op of delta) {
				if (!(op.insert instanceof Y.XmlText)) continue;
				const attrs = op.insert.getAttributes() as { __type?: unknown };
				if (attrs.__type === "title") titleCount += 1;
			}
			expect(titleCount).toBe(1);

			await raceSurface.unmount();
			api.dispose();
		} finally {
			seedResolver.dispose();
		}
	});

	it("leaves the TitleNode empty when storedTitle is empty (TitlePlugin owns the invariant)", async () => {
		// The TitlePlugin RootNode-transform fills the
		// "root.firstChild = TitleNode" invariant unconditionally, even
		// when our seeder leaves the title blank. Verified through the
		// Y.Doc's encoded body: the title structure is present but
		// carries no text. Asserting via the body's serialized string
		// (no internal Lexical editor handle needed) means we lean on
		// the public, persisted shape, which is what shipped clients
		// will see.
		const noteId = "n_test_seed_empty";
		const surface = mount(null);
		await surface.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor noteId={noteId} storedTitle="   " onChange={() => {}} noteContext={noteContext()} />
			</YDocProvider>,
		);

		const doc = resolver.docs.get(noteId);
		expect(doc).toBeDefined();
		if (!doc) return;
		const body = getUniversalBody(doc);
		// The encoded body declares the TitleNode via its node-type
		// attribute (`__type: "title"`) but carries no character runs —
		// `.toString()` is empty / whitespace-only because there's no
		// inline text. (Whitespace-only inserts from the title's empty
		// state aren't real characters.)
		expect(body.toString().trim()).toBe("");

		await surface.unmount();
	});
});

describe("Editor (N3) — Yjs UndoManager wiring (CollaborationPlugin owns history)", () => {
	let resolver: ReturnType<typeof inMemoryResolver>;

	beforeEach(() => {
		resolver = inMemoryResolver();
	});
	afterEach(() => {
		resolver.dispose();
	});

	it("registers UNDO_COMMAND + REDO_COMMAND handlers on the editor (no double-history with HistoryPlugin)", async () => {
		// CollaborationPlugin's `useYjsHistory` registers
		// `UNDO_COMMAND` and `REDO_COMMAND` against the Yjs UndoManager.
		// We assert via the public Lexical command surface: dispatching
		// the commands returns truthy (a registered handler returned
		// `true`). If we had ALSO stacked HistoryPlugin, two handlers
		// would race; we omit HistoryPlugin by construction in
		// `<BrainstormEditor>` (see its doc-comment).
		const noteId = "n_test_undo_wired";
		const surface = mount(null);
		await surface.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor
					noteId={noteId}
					storedTitle="Seeded for undo"
					onChange={() => {}}
					noteContext={noteContext()}
				/>
			</YDocProvider>,
		);

		const doc = resolver.docs.get(noteId);
		expect(doc).toBeDefined();
		if (!doc) return;
		const body = getUniversalBody(doc);
		// Body has the seeded title before we even reach for undo —
		// proves we're testing on a bound editor, not a stub.
		expect(body.toString()).toContain("Seeded for undo");

		// Reach for the editor handle the only way we have access to it
		// outside the composer: parse it off the contenteditable host
		// via `getNearestEditorFromDOMNode` (Lexical's published API).
		const { getNearestEditorFromDOMNode } = await import("lexical");
		const editable = surface.container.querySelector('[contenteditable="true"]');
		expect(editable).not.toBeNull();
		const editor = editable ? getNearestEditorFromDOMNode(editable) : null;
		expect(editor).not.toBeNull();
		if (!editor) return;

		// Both undo + redo dispatch return true (handler registered, ran,
		// claimed the event). The Yjs UndoManager's stacks may be empty
		// on a fresh editor — the proof is the handlers exist; the
		// applied behaviour on a real keystroke is exercised through the
		// CollaborationPlugin's own contract.
		const undoHandled = editor.dispatchCommand(UNDO_COMMAND, undefined);
		const redoHandled = editor.dispatchCommand(REDO_COMMAND, undefined);
		expect(undoHandled).toBe(true);
		expect(redoHandled).toBe(true);

		await surface.unmount();
	});
});

describe("Editor (N3) — AutosavePlugin first-real-interaction gate on Yjs transport", () => {
	let resolver: ReturnType<typeof inMemoryResolver>;

	beforeEach(() => {
		resolver = inMemoryResolver();
	});
	afterEach(() => {
		resolver.dispose();
	});

	it("a programmatic Y.Doc remote update does NOT promote into autosave (gate is real-interaction-only)", async () => {
		// The [[project_notes_autosave_swallows_first_edit]] invariant
		// on the new transport: a CRDT update streamed in from a sibling
		// client is NOT a user interaction; AutosavePlugin must not
		// promote it. Only KEY_DOWN / PASTE / CUT / DROP arms the next
		// commit. AutosavePlugin's gate is `userTouchedRef`: with no
		// user-origin command observed, no autosave can fire even after
		// arbitrary debounce settles (no setTimeout is even scheduled).
		const onChange = vi.fn();
		const noteId = "n_test_gate";
		const surface = mount(null);
		await surface.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor noteId={noteId} storedTitle="Seeded" onChange={onChange} noteContext={noteContext()} />
			</YDocProvider>,
		);

		const doc = resolver.docs.get(noteId);
		expect(doc).toBeDefined();
		if (!doc) return;

		// Apply a no-op remote update (the doc's own state vector,
		// applied back to itself, is a structurally valid no-op encoded
		// update). Real CRDT-shaped remote writes from a second
		// `@lexical/yjs` client land here in production; the autosave
		// gate's contract is independent of update content. We only need
		// to exercise the "Lexical reconciles a doc-side commit with no
		// user interaction" path.
		const Y = await import("yjs");
		const vector = Y.encodeStateVector(doc);
		const noopUpdate = Y.encodeStateAsUpdate(doc, vector);
		await act(async () => {
			applyUpdate(doc, noopUpdate);
		});

		// Wait past the autosave debounce window (200ms in the plugin)
		// to prove no save was scheduled. Real timers — fake timers race
		// React's scheduler under jsdom and abort with infinite-loop.
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(onChange).not.toHaveBeenCalled();

		await surface.unmount();
	});
});

describe("Editor (N3) — selection / IME parity proxy: remote edits don't tear down the editor", () => {
	let resolver: ReturnType<typeof inMemoryResolver>;

	beforeEach(() => {
		resolver = inMemoryResolver();
	});
	afterEach(() => {
		resolver.dispose();
	});

	it("a no-op remote update reconciles in place — the contenteditable host is the same node (no remount)", async () => {
		// IME / selection parity is hard to mechanically test (jsdom has
		// no real selection model, no composition events — see project
		// CLAUDE.md notes on testing scope). The proxiable property we
		// CAN test on the Yjs transport: a remote update reconciles in
		// the SAME contenteditable element (not a remount), which is the
		// precondition for any in-place selection or composition state
		// to survive. A remount would invalidate the DOM node identity.
		//
		// We apply a no-op encoded update so the test is independent of
		// @lexical/yjs's internal binding rules for what a "well-formed
		// remote write" looks like — the contract this asserts is
		// purely about lifecycle, not edit semantics.
		const noteId = "n_test_sel_parity";
		const surface = mount(null);
		await surface.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor noteId={noteId} storedTitle="Seeded" onChange={() => {}} noteContext={noteContext()} />
			</YDocProvider>,
		);

		const doc = resolver.docs.get(noteId);
		expect(doc).toBeDefined();
		if (!doc) return;
		const editableBefore = surface.container.querySelector('[contenteditable="true"]');
		expect(editableBefore).not.toBeNull();

		const Y = await import("yjs");
		await act(async () => {
			applyUpdate(doc, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc)));
		});

		const editableAfter = surface.container.querySelector('[contenteditable="true"]');
		expect(editableAfter).toBe(editableBefore);

		await surface.unmount();
	});

	it("a `storedTitle` prop change does NOT rebuild the bootstrap seeder (provider stays connected mid-typing)", async () => {
		// CollaborationPlugin lists `initialEditorState` in its effect deps,
		// so a freshly-built closure on every render would tear down +
		// reconnect the provider mid-typing — `storedTitle` updates on
		// every title autosave commit, so this would fire constantly. The
		// `useRef` capture in editor.tsx pins the seeder for the life of
		// the component instance; this test fences it by re-rendering
		// with a different `storedTitle` and asserting the contenteditable
		// host element is the same node (a provider tear-down would have
		// replaced it).
		const noteId = "n_test_bootstrap_stable";
		const surface = mount(null);
		await surface.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor noteId={noteId} storedTitle="Initial" onChange={() => {}} noteContext={noteContext()} />
			</YDocProvider>,
		);
		const editableBefore = surface.container.querySelector('[contenteditable="true"]');
		expect(editableBefore).not.toBeNull();

		await surface.render(
			<YDocProvider resolver={resolver.resolve}>
				<Editor
					noteId={noteId}
					storedTitle="Updated by autosave"
					onChange={() => {}}
					noteContext={noteContext()}
				/>
			</YDocProvider>,
		);
		const editableAfter = surface.container.querySelector('[contenteditable="true"]');
		expect(editableAfter).toBe(editableBefore);

		await surface.unmount();
	});
});

describe("Editor — imported (planted) docs keep their title across open cycles (F-423)", () => {
	// The importer plants `{type:"title"}` via the SeedTitleNode stand-in and
	// the runtime editor hydrates the REAL TitleNode over the same Yjs body.
	// The dogfood vault showed an imported note whose planted title survived
	// the first open but was EMPTY on the next cold open — so this repro
	// mounts the editor over a genuinely-planted doc TWICE and asserts the
	// title text is still in the CRDT after each cycle.
	function plantedResolver(noteId: string, title: string) {
		const source = new Doc();
		plantSerializedStateIntoDoc(
			source,
			{
				root: {
					type: "root",
					version: 1,
					format: "",
					indent: 0,
					direction: null,
					children: [
						{
							type: "title",
							version: 1,
							format: "",
							indent: 0,
							direction: null,
							children: [
								{
									type: "text",
									version: 1,
									detail: 0,
									format: 0,
									mode: "normal",
									style: "",
									text: title,
								},
							],
						},
						{
							type: "heading",
							version: 1,
							tag: "h1",
							format: "",
							indent: 0,
							direction: null,
							children: [
								{
									type: "text",
									version: 1,
									detail: 0,
									format: 0,
									mode: "normal",
									style: "",
									text: "Hausaufgabe 03.06.2026",
								},
							],
						},
					],
				},
			} as never,
			{ nodes: [...BASELINE_NODES, ...SEED_STANDIN_NODES], namespace: `test-plant-${noteId}` },
		);
		const snapshot = encodeStateAsUpdate(source);
		source.destroy();
		const docs = new Map<string, Doc>();
		const api = createYDocResolver({
			load: async () => snapshot,
			persist: () => {},
			release: () => {},
		});
		const wrappedResolve: typeof api.resolve = (id) => {
			const handle = api.resolve(id);
			docs.set(id, handle.doc);
			return handle;
		};
		return { resolve: wrappedResolve, docs, dispose: api.dispose };
	}

	it("keeps the planted title text after two mount/unmount cycles", async () => {
		const noteId = "n_imported_planted";
		const title = "Stunde 27 | Natasha";
		const resolver = plantedResolver(noteId, title);
		try {
			for (let cycle = 0; cycle < 2; cycle++) {
				const surface = mount(null);
				await surface.render(
					<YDocProvider resolver={resolver.resolve}>
						<Editor
							noteId={noteId}
							storedTitle={title}
							onChange={() => {}}
							noteContext={noteContext()}
						/>
					</YDocProvider>,
				);
				// Settle transforms + collab sync.
				await act(async () => {
					await Promise.resolve();
				});
				const doc = resolver.docs.get(noteId);
				expect(doc).toBeDefined();
				if (!doc) return;
				const body = getUniversalBody(doc);
				expect(body.toString(), `title text present in CRDT (cycle ${cycle})`).toContain(title);
				// Exactly one title element, and it still carries the text.
				const delta = body.toDelta() as ReadonlyArray<{ insert?: unknown }>;
				const titles = delta.filter(
					(op) =>
						op.insert instanceof XmlText &&
						(op.insert.getAttributes() as { __type?: unknown }).__type === "title",
				);
				expect(titles.length, `one title element (cycle ${cycle})`).toBe(1);
				const titleText = (titles[0]?.insert as XmlText | undefined)?.toString() ?? "";
				expect(titleText, `title element text (cycle ${cycle})`).toContain(title);
				await surface.unmount();
			}
		} finally {
			resolver.dispose();
		}
	});
});

describe("Editor — title heal on legacy title-less planted docs (F-423)", () => {
	it("fills an empty planted title from storedTitle at open", async () => {
		// Pre-F-402 import shape: body content, NO title node at all.
		const noteId = "n_imported_titleless";
		const source = new Doc();
		plantSerializedStateIntoDoc(
			source,
			{
				root: {
					type: "root",
					version: 1,
					format: "",
					indent: 0,
					direction: null,
					children: [
						{
							type: "heading",
							version: 1,
							tag: "h1",
							format: "",
							indent: 0,
							direction: null,
							children: [
								{
									type: "text",
									version: 1,
									detail: 0,
									format: 0,
									mode: "normal",
									style: "",
									text: "Hausaufgabe 03.06.2026",
								},
							],
						},
					],
				},
			} as never,
			{ nodes: [...BASELINE_NODES, ...SEED_STANDIN_NODES], namespace: "test-plant-titleless" },
		);
		const snapshot = encodeStateAsUpdate(source);
		source.destroy();
		const docs = new Map<string, Doc>();
		const api = createYDocResolver({
			load: async () => snapshot,
			persist: () => {},
			release: () => {},
		});
		const wrappedResolve: typeof api.resolve = (id) => {
			const handle = api.resolve(id);
			docs.set(id, handle.doc);
			return handle;
		};
		try {
			const surface = mount(null);
			await surface.render(
				<YDocProvider resolver={wrappedResolve}>
					<Editor
						noteId={noteId}
						storedTitle="Stunde 27 | Natasha"
						onChange={() => {}}
						noteContext={noteContext()}
					/>
				</YDocProvider>,
			);
			await act(async () => {
				await Promise.resolve();
			});
			const doc = docs.get(noteId);
			expect(doc).toBeDefined();
			if (!doc) return;
			const body = getUniversalBody(doc);
			const delta = body.toDelta() as ReadonlyArray<{ insert?: unknown }>;
			const titles = delta.filter(
				(op) =>
					op.insert instanceof XmlText &&
					(op.insert.getAttributes() as { __type?: unknown }).__type === "title",
			);
			expect(titles.length, "invariant prepends exactly one title").toBe(1);
			expect((titles[0]?.insert as XmlText | undefined)?.toString() ?? "").toContain(
				"Stunde 27 | Natasha",
			);
			// The body heading is untouched.
			expect(body.toString()).toContain("Hausaufgabe 03.06.2026");
			await surface.unmount();
		} finally {
			api.dispose();
		}
	});
});

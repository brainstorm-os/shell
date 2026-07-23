/**
 * Welcome-1a — the preseeded "Get started" starter set (pure content keystone).
 *
 * This module is the **single source of the bundled starter content**: one
 * entity per core bundled app, cross-linked through `@`-mention nodes in the
 * hub note's body so the Graph app paints a non-empty default subgraph on
 * first launch (OQ-WC-2 v1 lean (b)). It is deliberately pure — no I/O, no
 * entities-service calls, no `Date.now()` — so it is fully unit-testable and
 * deterministic. The seeder slice (Welcome-1b) consumes `buildWelcomeStarterSet`
 * to create the entities through the in-process entities service and plant the
 * note bodies via `plantSerializedStateIntoDoc`; the seed lands inside vault
 * initialization, before the dashboard mounts (OQ-WC-1 resolved 2026-05-31).
 *
 * The body JSON mirrors the seed-cli's persisted Lexical shape
 * (`tools/mcp-server/src/seed/seed-nodes.ts` + `wikilinks.ts`): the same
 * `type:"mention"` + `entityId` + `entityType` contract the shell parses in
 * `extract-note-references.ts` to derive note→entity edges. Mention targets
 * are constrained to ids that exist in the set, so `listVaultEntities` never
 * drops a starter edge as dangling.
 *
 * Idempotency + reversibility: every entity carries a stable, deterministic id
 * (`welcome-…`) so a re-run overwrites in place rather than duplicating, and
 * the whole set removes cleanly through Bin (soft-delete) without trace. The
 * seeder gates on a per-vault `welcome:seedVersion` stamp so it runs once.
 */

import { NoteReferenceKind, extractNoteReferences } from "../entities/extract-note-references";
import {
	NOTE_MENTION_LINK_TYPE,
	NOTE_REFERENCE_LINK_TYPE,
	noteLinkId,
} from "../entities/note-entities-codec";

/** Canonical BP type ids the starter entities use (verified against the
 *  in-use strings across `packages/`, `apps/`, `tools/`). */
export enum WelcomeEntityType {
	Note = "io.brainstorm.notes/Note/v1",
	JournalEntry = "io.brainstorm.journal/Entry/v1",
	Task = "brainstorm/Task/v1",
	Project = "brainstorm/Project/v1",
	Folder = "brainstorm/Folder/v1",
	Event = "brainstorm/Event/v1",
	Whiteboard = "brainstorm/Whiteboard/v1",
	Bookmark = "brainstorm/Bookmark/v1",
}

/** Bumped when the bundled starter content changes shape; the seeder compares
 *  it to the per-vault stamp and re-seeds only on a strict increase. */
export const WELCOME_SEED_VERSION = 1;

/** Per-vault KV key holding the last-seeded `WELCOME_SEED_VERSION`. */
export const WELCOME_SEED_STAMP_KEY = "welcome:seedVersion";

/** `created_by` attribution for seeded entities — the shell vouches for its
 *  own seed (a sentinel, never a real app id, so it can't be spoofed and is
 *  trivially auditable / purgeable). */
export const WELCOME_SEED_CREATED_BY = "io.brainstorm.welcome";

/** Stable-id namespace; every starter entity id begins with this so the seeder
 *  can detect a prior seed and a user can recognise the set in Bin. */
export const WELCOME_ID_PREFIX = "welcome-";

const HUB_ID = `${WELCOME_ID_PREFIX}note-hub`;
const TASK_ID = `${WELCOME_ID_PREFIX}task-tour`;
const PROJECT_ID = `${WELCOME_ID_PREFIX}project-getting-started`;
const FOLDER_ID = `${WELCOME_ID_PREFIX}folder-files`;
const EVENT_ID = `${WELCOME_ID_PREFIX}event-explore`;
const WHITEBOARD_ID = `${WELCOME_ID_PREFIX}whiteboard-sketch`;
const BOOKMARK_ID = `${WELCOME_ID_PREFIX}bookmark-docs`;
const JOURNAL_ID = `${WELCOME_ID_PREFIX}journal-day-one`;

const DAY_MS = 86_400_000;

// --- Lexical body shapes (structural mirror of the persisted seed shape) ---

type Inline =
	| { type: "text"; version: 1; format: 0; mode: "normal"; style: ""; text: string; detail: 0 }
	| { type: "mention"; version: 1; entityId: string; entityType: string; label: string };

type Block = {
	type: "title" | "paragraph";
	version: 1;
	format: "";
	indent: 0;
	direction: null;
	children: Inline[];
};

/** A serialized Lexical editor state — the shape `plantSerializedStateIntoDoc`
 *  parses and `extractNoteReferences` walks. */
export type WelcomeBody = {
	root: { type: "root"; version: 1; format: ""; indent: 0; direction: null; children: Block[] };
};

/** One bundled starter entity. `body` is present only for editor-backed
 *  entities (the hub note + the journal entry). */
export type WelcomeStarterEntity = {
	readonly id: string;
	readonly type: WelcomeEntityType;
	readonly properties: Record<string, unknown>;
	readonly body?: WelcomeBody;
};

function text(value: string): Inline {
	return { type: "text", version: 1, format: 0, mode: "normal", style: "", text: value, detail: 0 };
}

function mention(target: WelcomeStarterEntity, label: string): Inline {
	return { type: "mention", version: 1, entityId: target.id, entityType: target.type, label };
}

function title(value: string): Block {
	return {
		type: "title",
		version: 1,
		format: "",
		indent: 0,
		direction: null,
		children: [text(value)],
	};
}

function paragraph(children: Inline[]): Block {
	return { type: "paragraph", version: 1, format: "", indent: 0, direction: null, children };
}

function body(children: Block[]): WelcomeBody {
	return { root: { type: "root", version: 1, format: "", indent: 0, direction: null, children } };
}

/**
 * Build the bundled starter set. Deterministic in `now` (no `Date.now()`), so
 * the same `now` always yields byte-identical output. Order is stable — the
 * hub note first so the dashboard's most-recent surface opens onto it.
 *
 * @param now epoch-ms timestamp the seeder stamps onto every entity.
 */
export function buildWelcomeStarterSet(now: number): WelcomeStarterEntity[] {
	const ts = { createdAt: now, updatedAt: now };

	const task: WelcomeStarterEntity = {
		id: TASK_ID,
		type: WelcomeEntityType.Task,
		properties: { name: "Take the product tour", status: "todo", dueAt: now + DAY_MS, ...ts },
	};
	const project: WelcomeStarterEntity = {
		id: PROJECT_ID,
		type: WelcomeEntityType.Project,
		properties: { name: "Getting started", ...ts },
	};
	const folder: WelcomeStarterEntity = {
		id: FOLDER_ID,
		type: WelcomeEntityType.Folder,
		properties: { name: "My first folder", members: [], ...ts },
	};
	const event: WelcomeStarterEntity = {
		id: EVENT_ID,
		type: WelcomeEntityType.Event,
		properties: {
			title: "Explore Brainstorm",
			start: now + DAY_MS,
			end: now + DAY_MS + 3_600_000,
			allDay: false,
			...ts,
		},
	};
	const whiteboard: WelcomeStarterEntity = {
		id: WHITEBOARD_ID,
		type: WelcomeEntityType.Whiteboard,
		properties: {
			name: "Your first sketch",
			description: "A blank canvas — drag, draw, and connect ideas.",
			nodes: [],
			...ts,
		},
	};
	const bookmark: WelcomeStarterEntity = {
		id: BOOKMARK_ID,
		type: WelcomeEntityType.Bookmark,
		// `savedAt` is required by the Bookmarks app's stored-bookmark codec —
		// omit it and the app drops the row (invisible in Bookmarks though
		// Database/Graph show it).
		properties: {
			title: "Brainstorm — help & docs",
			url: "https://brainstorm.app",
			savedAt: now,
			...ts,
		},
	};

	// A real journal entry, dated to the seed day, so the Journal app opens
	// onto a populated first day. Its title MUST be the ISO date (the Journal
	// projection keys entries by an `YYYY-MM-DD` title); the UTC derivation
	// keeps the output byte-identical for a given `now`.
	const journalDateKey = new Date(now).toISOString().slice(0, 10);
	const journal: WelcomeStarterEntity = {
		id: JOURNAL_ID,
		type: WelcomeEntityType.JournalEntry,
		properties: { title: journalDateKey, ...ts },
		body: body([
			title(journalDateKey),
			paragraph([text("Your first journal entry. Today you opened Brainstorm for the first time.")]),
			paragraph([text("A good first step: "), mention(task, "Take the product tour"), text(".")]),
		]),
	};

	// The hub note mentions every other starter entity so Graph paints a
	// non-trivial default subgraph and discovery is fair across apps.
	const hub: WelcomeStarterEntity = {
		id: HUB_ID,
		type: WelcomeEntityType.Note,
		properties: { title: "Welcome to Brainstorm", ...ts },
		body: body([
			title("Welcome to Brainstorm"),
			paragraph([
				text(
					"This is your dashboard. Open apps from the launcher, switch windows with the strip below, and press ? any time to see what's new and find help.",
				),
			]),
			paragraph([
				text("We made you a few things to start: "),
				mention(task, "a task"),
				text(" inside "),
				mention(project, "Getting started"),
				text(", "),
				mention(folder, "a folder"),
				text(", "),
				mention(event, "a calendar event"),
				text(", "),
				mention(whiteboard, "a whiteboard"),
				text(", "),
				mention(bookmark, "a bookmark"),
				text(", and "),
				mention(journal, "today's journal entry"),
				text("."),
			]),
			paragraph([
				text(
					"Everything here is yours — edit it, link more of it together with @-mentions, or move it all to the Bin when you're ready to start fresh.",
				),
			]),
		]),
	};

	return [hub, task, project, folder, event, whiteboard, bookmark, journal];
}

/** A note→entity link the seeder materialises for the starter set. */
export type WelcomeSeedLink = {
	readonly id: string;
	readonly sourceEntityId: string;
	readonly destEntityId: string;
	readonly linkType: string;
	readonly createdAt: number;
};

/**
 * Mention links for the starter set, derived from the SAME
 * `extractNoteReferences` the Notes codec runs on a saved note — so the link
 * ids and types are byte-identical to what a later edit of the hub note would
 * produce (idempotent: re-extraction on first edit never duplicates a seeded
 * link). Materialising these at seed time is what makes Graph + backlinks paint
 * a connected subgraph on first open; without it the `@`-mentions become real
 * links only after the note is first edited, and the Graph opens edge-less.
 */
export function buildWelcomeStarterLinks(now: number): WelcomeSeedLink[] {
	const links: WelcomeSeedLink[] = [];
	for (const entity of buildWelcomeStarterSet(now)) {
		if (!entity.body) continue;
		for (const ref of extractNoteReferences(entity.body)) {
			links.push({
				id: noteLinkId(entity.id, ref.kind, ref.entityId),
				sourceEntityId: entity.id,
				destEntityId: ref.entityId,
				linkType:
					ref.kind === NoteReferenceKind.Mention ? NOTE_MENTION_LINK_TYPE : NOTE_REFERENCE_LINK_TYPE,
				createdAt: now,
			});
		}
	}
	return links;
}

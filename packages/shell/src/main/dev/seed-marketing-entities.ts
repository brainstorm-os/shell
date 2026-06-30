/**
 * Dev-only seeder for a believable **real-world** knowledge base, used to
 * capture marketing screenshots for getbrainstorm.online. Unlike
 * `seed-demo-entities` (which tracks Brainstorm's own launch — insider/meta)
 * and the plan-projection reseed (dev iteration ids), this seeds a coherent
 * small studio's workspace: clients, projects, people, notes, tasks and
 * events that read like a real team's vault.
 *
 * Same `EntitiesRepository` the real apps read, own `mkt_*` id namespace,
 * idempotent on its marker row. Never runs in production (gated behind the
 * `dev:seed-marketing-entities` channel, which dev-handlers only registers
 * under `!app.isPackaged`).
 */

import { COMPANY_TYPE } from "../entities/company-migration";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import type { VaultSession } from "../vault/session";
import { seedPlanProperties } from "./plan-properties";

const BOOKMARK_TYPE = "brainstorm/Bookmark/v1";
const JOURNAL_TYPE = "io.brainstorm.journal/Entry/v1";
const WHITEBOARD_TYPE = "brainstorm/Whiteboard/v1";
const BOOKMARKS_APP = "io.brainstorm.bookmarks";
const JOURNAL_APP = "io.brainstorm.journal";
const WHITEBOARD_APP = "io.brainstorm.whiteboard";

const TASK_TYPE = "brainstorm/Task/v1";
const PROJECT_TYPE = "brainstorm/Project/v1";
const EVENT_TYPE = "brainstorm/Event/v1";
const NOTE_TYPE = "io.brainstorm.notes/Note/v1";
const PERSON_TYPE = "brainstorm/Person/v1";
const TASK_IN_PROJECT_LINK = "brainstorm/Task/in-project";

const CONVERSATION_TYPE = "brainstorm/Conversation/v1";
const MESSAGE_TYPE = "brainstorm/Message/v1";

const TASKS_APP = "io.brainstorm.tasks";
const CALENDAR_APP = "io.brainstorm.calendar";
const NOTES_APP = "io.brainstorm.notes";
const CONTACTS_PROV = "io.brainstorm.contacts";
const AGENT_APP = "io.brainstorm.agent";

/** Universal emoji icon, the shape `properties.icon` expects. */
const emoji = (value: string) => ({ kind: "emoji", value });

const DAY = 86_400_000;
const YEAR = 365 * DAY;

type Mention = { entityId: string; entityType: string; label: string };

/** Minimal valid Lexical `SerializedEditorState` — one or more paragraphs,
 *  optional inline mention chips on the first. Matches the shape the Notes
 *  app hydrates and the reference-extraction walker reads. */
function noteBody(paragraphs: string[], mentions: Mention[] = []): unknown {
	const textNode = (t: string) => ({
		type: "text",
		text: t,
		detail: 0,
		format: 0,
		mode: "normal",
		style: "",
		version: 1,
	});
	const para = (children: unknown[]) => ({
		type: "paragraph",
		format: "",
		indent: 0,
		version: 1,
		direction: "ltr",
		textFormat: 0,
		textStyle: "",
		children,
	});
	const blocks: unknown[] = [];
	paragraphs.forEach((text, i) => {
		const children: unknown[] = [textNode(text)];
		if (i === 0) {
			for (const m of mentions) {
				children.push(textNode(" "));
				children.push({
					type: "mention",
					version: 1,
					entityId: m.entityId,
					entityType: m.entityType,
					label: m.label,
				});
			}
		}
		blocks.push(para(children));
	});
	return {
		root: { type: "root", format: "", indent: 0, version: 1, direction: "ltr", children: blocks },
	};
}

function isoDateKey(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function todayAt(now: number, hour: number, minute = 0): number {
	const d = new Date(now);
	d.setHours(hour, minute, 0, 0);
	return d.getTime();
}

export type SeedMarketingResult = { seeded: boolean; counts?: Record<string, number> };

export async function seedMarketingEntities(session: VaultSession): Promise<SeedMarketingResult> {
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	const now = Date.now();

	const markerId = "mkt_studio";
	if (repo.get(markerId)) return { seeded: false };

	// Register the Status/Priority property defs + their coloured dictionaries
	// so the Database app labels them "Status"/"Priority" and renders values as
	// pills (instead of the raw "statusKey" column with plain text).
	await seedPlanProperties(session);

	const mk = (id: string, type: string, createdBy: string, properties: Record<string, unknown>) =>
		repo.create({ id, type, createdBy, properties, now, dekId: null });

	// ── The studio + its clients (Company/v1) ──────────────────────────
	mk(markerId, COMPANY_TYPE, CONTACTS_PROV, {
		name: "Northbound Studio",
		createdAt: now - 400 * DAY,
		updatedAt: now,
	});
	const companies: Array<[string, string]> = [
		["mkt_co_harbor", "Harbor & Co"],
		["mkt_co_meridian", "Meridian Health"],
		["mkt_co_atlas", "Atlas Robotics"],
	];
	for (const [id, name] of companies) {
		mk(id, COMPANY_TYPE, CONTACTS_PROV, { name, createdAt: now - 120 * DAY, updatedAt: now });
	}

	// ── People (Contacts) ──────────────────────────────────────────────
	const people: Array<[string, Record<string, unknown>]> = [
		[
			"mkt_p_maya",
			{
				name: "Maya Chen",
				email: ["maya@northbound.studio"],
				phone: ["+1 555 0110"],
				company: "mkt_studio",
				role: "Founder & Creative Director",
				birthday: now - 36 * YEAR,
			},
		],
		[
			"mkt_p_tom",
			{
				name: "Tom Becker",
				email: ["tom@northbound.studio"],
				company: "mkt_studio",
				role: "Product Designer",
				birthday: now - 31 * YEAR,
			},
		],
		[
			"mkt_p_priya",
			{
				name: "Priya Raman",
				email: ["priya@harborandco.com"],
				phone: ["+1 555 0188"],
				company: "mkt_co_harbor",
				role: "Head of Marketing",
			},
		],
		[
			"mkt_p_daniel",
			{
				name: "Daniel Ortiz",
				email: ["d.ortiz@meridianhealth.org"],
				phone: ["+1 555 0164"],
				company: "mkt_co_meridian",
				role: "Director of Operations",
				birthday: now - 47 * YEAR,
				links: ["mkt_proj_meridian"],
				notes:
					"Decision-maker on the booking app. Prefers a short weekly update over long docs. " +
					"Cares most about reducing no-shows.",
			},
		],
		[
			"mkt_p_sophie",
			{
				name: "Sophie Lambert",
				email: ["sophie@atlasrobotics.io"],
				phone: ["+1 555 0177"],
				company: "mkt_co_atlas",
				role: "VP Product",
				birthday: now - 38 * YEAR,
				links: ["mkt_proj_atlas"],
				notes: "Drove the Series A deck. Sharp on narrative; light touch on visuals — trusts us there.",
			},
		],
	];
	for (const [id, props] of people) {
		mk(id, PERSON_TYPE, CONTACTS_PROV, { ...props, createdAt: now - 90 * DAY, updatedAt: now });
	}

	// ── Client projects ────────────────────────────────────────────────
	const projects: Array<[string, Record<string, unknown>]> = [
		[
			"mkt_proj_harbor",
			{
				name: "Harbor & Co — Brand refresh",
				icon: emoji("☕"),
				description:
					"New identity and packaging system for a specialty coffee roaster moving into retail. " +
					"Logo, type, colour, and a packaging family across three roast levels.",
				statusKey: "active",
				colorHint: "#c2632f",
				milestoneAt: now + 21 * DAY,
			},
		],
		[
			"mkt_proj_meridian",
			{
				name: "Meridian — Booking app",
				icon: emoji("🩺"),
				description:
					"Patient-facing appointment booking for a multi-site clinic. Research, flows, and a " +
					"design system the in-house team can carry forward.",
				statusKey: "active",
				colorHint: "#2f7dc2",
				milestoneAt: now + 45 * DAY,
			},
		],
		[
			"mkt_proj_atlas",
			{
				name: "Atlas — Series A deck",
				icon: emoji("🤖"),
				description: "Narrative and slide system for a robotics startup's Series A raise.",
				statusKey: "done",
				colorHint: "#6c5ce7",
			},
		],
	];
	for (const [id, props] of projects) {
		mk(id, PROJECT_TYPE, TASKS_APP, { ...props, createdAt: now - 60 * DAY, updatedAt: now });
	}

	// ── Tasks (varied status/priority/dates) ───────────────────────────
	type T = [string, string, Record<string, unknown>];
	const tasks: T[] = [
		// Harbor
		[
			"mkt_t_h1",
			"mkt_proj_harbor",
			{
				name: "Present three brand directions",
				priority: "high",
				statusKey: "in-flight",
				scheduledAt: todayAt(now, 10),
				dueAt: now + 1 * DAY,
			},
		],
		[
			"mkt_t_h2",
			"mkt_proj_harbor",
			{ name: "Refine the wordmark", priority: "medium", statusKey: "todo", dueAt: now + 4 * DAY },
		],
		[
			"mkt_t_h3",
			"mkt_proj_harbor",
			{
				name: "Source a packaging printer",
				priority: "medium",
				statusKey: "todo",
				dueAt: now + 9 * DAY,
			},
		],
		[
			"mkt_t_h4",
			"mkt_proj_harbor",
			{
				name: "Collect reference roasters",
				priority: "low",
				statusKey: "done",
				completedAt: now - 3 * DAY,
			},
		],
		// Meridian
		[
			"mkt_t_m1",
			"mkt_proj_meridian",
			{
				name: "Map the booking flow",
				priority: "high",
				statusKey: "in-flight",
				scheduledAt: now + 1 * DAY,
			},
		],
		[
			"mkt_t_m2",
			"mkt_proj_meridian",
			{
				name: "Design the appointment screen",
				priority: "high",
				statusKey: "todo",
				dueAt: now + 6 * DAY,
			},
		],
		[
			"mkt_t_m3",
			"mkt_proj_meridian",
			{
				name: "Recruit 5 patients for testing",
				priority: "medium",
				statusKey: "todo",
				dueAt: now + 8 * DAY,
			},
		],
		[
			"mkt_t_m4",
			"mkt_proj_meridian",
			{
				name: "Write the research plan",
				priority: "medium",
				statusKey: "done",
				completedAt: now - 2 * DAY,
			},
		],
		// Atlas
		[
			"mkt_t_a1",
			"mkt_proj_atlas",
			{
				name: "Final rehearsal with Sophie",
				priority: "high",
				statusKey: "done",
				completedAt: now - 6 * DAY,
			},
		],
		[
			"mkt_t_a2",
			"mkt_proj_atlas",
			{
				name: "Export the deck to PDF",
				priority: "low",
				statusKey: "done",
				completedAt: now - 5 * DAY,
			},
		],
		// Studio / no project
		[
			"mkt_t_s1",
			"",
			{ name: "Send Q3 invoices", priority: "high", statusKey: "todo", dueAt: now + 2 * DAY },
		],
		["mkt_t_s2", "", { name: "Update the portfolio site", priority: "low", statusKey: "todo" }],
		[
			"mkt_t_s3",
			"",
			{ name: "Order new business cards", priority: "low", statusKey: "todo", dueAt: now + 12 * DAY },
		],
		[
			"mkt_t_h5",
			"mkt_proj_harbor",
			{
				name: "Mock up the Light-roast bag",
				priority: "medium",
				statusKey: "in-flight",
				scheduledAt: now + 2 * DAY,
			},
		],
		[
			"mkt_t_m5",
			"mkt_proj_meridian",
			{ name: "Audit the reminder emails", priority: "low", statusKey: "todo", dueAt: now + 10 * DAY },
		],
	];
	const TASK_ICONS: Record<string, string> = {
		mkt_t_h1: "🎨",
		mkt_t_h2: "✍️",
		mkt_t_h3: "📦",
		mkt_t_h4: "🔍",
		mkt_t_h5: "🛍️",
		mkt_t_m1: "🗺️",
		mkt_t_m2: "📱",
		mkt_t_m3: "🧑‍🤝‍🧑",
		mkt_t_m4: "📋",
		mkt_t_m5: "✉️",
		mkt_t_a1: "🎤",
		mkt_t_a2: "📄",
		mkt_t_s1: "💸",
		mkt_t_s2: "🌐",
		mkt_t_s3: "🪪",
	};
	for (const [id, projectId, props] of tasks) {
		mk(id, TASK_TYPE, TASKS_APP, {
			...props,
			...(TASK_ICONS[id] ? { icon: emoji(TASK_ICONS[id]) } : {}),
			...(projectId ? { projectId } : {}),
			parentId: null,
			createdAt: now - 30 * DAY,
			updatedAt: now,
		});
		if (projectId) {
			repo.putLink({
				id: `mkt_lnk_${id}`,
				sourceEntityId: id,
				destEntityId: projectId,
				linkType: TASK_IN_PROJECT_LINK,
				createdAt: now,
			});
		}
	}

	// ── Calendar events ────────────────────────────────────────────────
	const events: Array<[string, Record<string, unknown>]> = [
		["mkt_e1", { title: "Harbor brand review", start: todayAt(now, 10), end: todayAt(now, 11) }],
		["mkt_e2", { title: "Studio standup", start: todayAt(now, 9, 30), end: todayAt(now, 9, 45) }],
		[
			"mkt_e3",
			{
				title: "Meridian kickoff",
				start: todayAt(now, 14) + 2 * DAY,
				end: todayAt(now, 15) + 2 * DAY,
			},
		],
		[
			"mkt_e4",
			{
				title: "Coffee with Priya",
				start: todayAt(now, 16) + 3 * DAY,
				end: todayAt(now, 17) + 3 * DAY,
			},
		],
		["mkt_e5", { title: "Invoices due", start: todayAt(now, 0) + 2 * DAY, end: null, allDay: true }],
	];
	for (const [id, props] of events) {
		mk(id, EVENT_TYPE, CALENDAR_APP, { ...props, createdAt: now - 10 * DAY, updatedAt: now });
	}

	// ── Notes (real prose; mentions → graph edges) ─────────────────────
	const note = (id: string, title: string, icon: string, body: unknown) =>
		mk(id, NOTE_TYPE, NOTES_APP, {
			title,
			icon: emoji(icon),
			body,
			values: {},
			createdAt: now - 20 * DAY,
			updatedAt: now,
		});

	note(
		"mkt_n_brief",
		"Harbor & Co — Brand brief",
		"📋",
		noteBody(
			[
				"Harbor & Co roast small-batch coffee and are moving from wholesale into their own retail line. The refresh has to feel crafted but not precious — warm, honest, a little nautical without leaning on clichés.",
				"Audience: people who already care about good coffee and are curious about where it comes from. Tone: plainspoken, confident, generous. Deliverables: wordmark, a flexible mark, a roast-level colour system, and packaging across Light / Medium / Dark.",
				"Open question for the review: do we commit to one illustration style for origin stories, or keep it typographic? Bringing three directions to the call.",
			],
			[
				{ entityId: "mkt_proj_harbor", entityType: PROJECT_TYPE, label: "Harbor & Co — Brand refresh" },
				{ entityId: "mkt_p_priya", entityType: PERSON_TYPE, label: "Priya Raman" },
			],
		),
	);
	note(
		"mkt_n_research",
		"Meridian booking — research notes",
		"🔎",
		noteBody(
			[
				"Five interviews with patients booking across the three Meridian sites. The recurring pain: nobody knows which location has the earliest slot, so they call around. The app should answer that on the first screen.",
				"Secondary finding: people abandon when they hit a login wall before seeing any availability. Show times first, ask who you are second.",
			],
			[{ entityId: "mkt_proj_meridian", entityType: PROJECT_TYPE, label: "Meridian — Booking app" }],
		),
	);
	// This note carries an embedded bookmark card — the Notes embed block.
	mk("mkt_n_reading", NOTE_TYPE, NOTES_APP, {
		title: "Reading — Designing for trust",
		icon: emoji("📖"),
		body: {
			root: {
				type: "root",
				format: "",
				indent: 0,
				version: 1,
				direction: "ltr",
				children: [
					{
						type: "paragraph",
						format: "",
						indent: 0,
						version: 1,
						direction: "ltr",
						textFormat: 0,
						textStyle: "",
						children: [
							{
								type: "text",
								text:
									"The line that stuck: trust is built in the boring moments — a confirmation that arrives when it says it will, a cancellation that actually cancels. Apply this to the Meridian reminders.",
								detail: 0,
								format: 0,
								mode: "normal",
								style: "",
								version: 1,
							},
						],
					},
					{
						type: "bookmark",
						version: 1,
						url: "https://www.nngroup.com/articles/service-design-101/",
						title: "Service Design 101",
						description:
							"How the moments between a customer and an organisation add up to trust — the framing behind the Meridian reminders work.",
					},
				],
			},
		},
		values: {},
		createdAt: now - 20 * DAY,
		updatedAt: now,
	});
	note(
		"mkt_n_week",
		"This week",
		"🗓️",
		noteBody([
			"Harbor review is the big one — three directions, get a decision. Kick off Meridian once the research plan is signed off. Invoices out by Wednesday. Block Friday afternoon for the portfolio update we keep pushing.",
		]),
	);
	note(
		`mkt_n_${isoDateKey(now)}`,
		isoDateKey(now),
		"📓",
		noteBody([
			"Good Harbor session — the warm direction landed, Priya wants to see it on packaging next. Tom started the Meridian flow map. Slow afternoon, caught up on email.",
		]),
	);

	// ── Bookmarks ──────────────────────────────────────────────────────
	// A small data-URI cover (gradient + monogram) so cards aren't blank.
	const cover = (letter: string, c1: string, c2: string) => {
		const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs><rect width='320' height='180' fill='url(#g)'/><text x='160' y='118' font-family='Georgia, serif' font-size='96' font-weight='700' fill='rgba(255,255,255,0.92)' text-anchor='middle'>${letter}</text></svg>`;
		return `data:image/svg+xml,${encodeURIComponent(svg)}`;
	};
	const bookmarks: Array<[string, Record<string, unknown>]> = [
		[
			"mkt_bm_type",
			{
				url: "https://fontsinuse.com",
				title: "Fonts In Use",
				description: "Type-led design reference, indexed by typeface, industry and era.",
				tags: ["type", "reference"],
				colorHint: "#e11d48",
				coverImageUrl: cover("F", "#fb7185", "#be123c"),
			},
		],
		[
			"mkt_bm_roasters",
			{
				url: "https://www.standartmag.com",
				title: "Standart — coffee culture magazine",
				description: "Mood and tone reference for the Harbor & Co retail line.",
				tags: ["harbor", "reference"],
				colorHint: "#c2632f",
				coverImageUrl: cover("S", "#f59e0b", "#c2632f"),
			},
		],
		[
			"mkt_bm_a11y",
			{
				url: "https://www.w3.org/WAI/WCAG22/quickref/",
				title: "WCAG 2.2 quick reference",
				description: "Accessibility checklist for the Meridian booking flow.",
				tags: ["meridian", "a11y"],
				colorHint: "#2f7dc2",
				coverImageUrl: cover("W", "#38bdf8", "#2f7dc2"),
			},
		],
		[
			"mkt_bm_pricing",
			{
				url: "https://stripe.com/docs/invoicing",
				title: "Stripe Invoicing docs",
				description: "Set up the studio's Q3 invoicing.",
				tags: ["ops"],
				colorHint: "#6c5ce7",
				coverImageUrl: cover("S", "#a78bfa", "#6c5ce7"),
			},
		],
	];
	for (const [id, props] of bookmarks) {
		mk(id, BOOKMARK_TYPE, BOOKMARKS_APP, {
			...props,
			savedAt: now - 6 * DAY,
			readAt: null,
			archivedAt: null,
			createdAt: now - 6 * DAY,
			updatedAt: now,
		});
	}

	// ── Journal entries (date-titled, multi-paragraph) ─────────────────
	const journal = (daysAgo: number, paragraphs: string[]) => {
		const ms = now - daysAgo * DAY;
		mk(`mkt_jr_${isoDateKey(ms)}`, JOURNAL_TYPE, JOURNAL_APP, {
			title: isoDateKey(ms),
			icon: emoji("📓"),
			body: noteBody(paragraphs),
			values: {},
			createdAt: ms,
			updatedAt: ms,
		});
	};
	journal(1, [
		"Three brand directions for Harbor are ready. The warm one is my favourite — restrained, a little nautical without leaning on rope-and-anchor clichés.",
		"Spent the afternoon getting the wordmark to sit right on the bag mock-up. It's close. The kerning on the 'b' still bugs me but I'll leave it overnight and look again.",
		"Nervous about the review tomorrow, but it's good work and I trust it. Note to self: lead with the why, not the logos.",
	]);
	journal(3, [
		"Long day on the Meridian flow map with Tom. We keep circling the same truth: show availability before the login wall. Everything else follows from that one decision.",
		"Funny how often the hard part isn't the design — it's getting everyone to agree on what problem we're actually solving. We got there by lunch.",
	]);
	journal(6, [
		"Quiet Sunday. Read about service design and trust — the idea that reliability in the small, boring moments is the whole game. A confirmation that arrives on time does more than any clever screen.",
		"Sketched a little, didn't force it. Walked. Made a proper coffee and actually tasted it, which felt on-brand.",
	]);

	// ── Whiteboard (sticky-note board; nodes inlined) ──────────────────
	const sticky = (
		id: string,
		x: number,
		y: number,
		text: string,
		color: string,
	): Record<string, unknown> => ({
		id,
		kind: "sticky",
		x,
		y,
		width: 200,
		height: 130,
		text,
		color,
	});
	mk("mkt_wb_harbor", WHITEBOARD_TYPE, WHITEBOARD_APP, {
		name: "Harbor — packaging directions",
		icon: emoji("☕"),
		nodes: [
			sticky("s1", 80, 80, "Warm & honest\n— restrained, nautical without clichés", "yellow"),
			sticky("s2", 320, 80, "Bold & graphic\n— big wordmark, roast colour blocks", "blue"),
			sticky("s3", 560, 80, "Crafted & quiet\n— typographic, lots of paper", "pink"),
			sticky("s4", 200, 300, "Light roast → soft cream label", "green"),
			sticky("s5", 440, 300, "Dark roast → deep, single-colour", "purple"),
			{
				id: "t1",
				kind: "text",
				x: 80,
				y: 24,
				width: 400,
				height: 40,
				text: "Three directions for the review",
			},
		],
		createdAt: now - 4 * DAY,
		updatedAt: now,
	});
	// Connectors (arrows) between the stickies — WhiteboardEdge/v1.
	const wbEdge = (
		n: string,
		src: string,
		srcH: string,
		dst: string,
		dstH: string,
		label: string | null,
	) =>
		mk(`mkt_wbe_${n}`, "brainstorm/WhiteboardEdge/v1", WHITEBOARD_APP, {
			whiteboardId: "mkt_wb_harbor",
			sourceNodeId: src,
			sourceHandle: srcH,
			destNodeId: dst,
			destHandle: dstH,
			pathKind: "bezier",
			arrowHead: "arrow",
			label,
			colorHint: "#be123c",
			createdAt: now - 4 * DAY,
			updatedAt: now,
		});
	wbEdge("1", "s1", "bottom", "s4", "top", "pairs with");
	wbEdge("2", "s2", "bottom", "s5", "top", "pairs with");
	wbEdge("3", "s2", "right", "s3", "left", null);
	wbEdge("4", "s1", "right", "s2", "left", null);

	// ── Agent conversations (chat list + a real transcript) ────────────
	// Conversation/v1 { title } + Message/v1 { conversation, role, body, seq,
	// createdAt(ISO) }. ROW timestamps are staggered (not the shared `now`) so
	// the transcript thread is unambiguously the newest and the app opens onto
	// it; the others fill the sidebar list.
	const mkAt = (
		id: string,
		type: string,
		createdBy: string,
		properties: Record<string, unknown>,
		rowNow: number,
	) => repo.create({ id, type, createdBy, properties, now: rowNow, dekId: null });

	const conversation = (id: string, title: string, ageMin: number) =>
		mkAt(
			id,
			CONVERSATION_TYPE,
			AGENT_APP,
			{ title, createdAt: now - ageMin * 60_000, updatedAt: now - ageMin * 60_000 },
			now - ageMin * 60_000,
		);

	let msgSeq = 0;
	const message = (
		convId: string,
		role: string,
		body: string,
		ageMin: number,
		attachments?: ReadonlyArray<Record<string, unknown>>,
	) =>
		mkAt(
			`mkt_msg_${convId}_${msgSeq}`,
			MESSAGE_TYPE,
			AGENT_APP,
			{
				conversation: convId,
				role,
				body,
				seq: msgSeq++,
				createdAt: new Date(now - ageMin * 60_000).toISOString(),
				...(role === "assistant" ? { aiProvenance: { model: "local · llama-3.1-8b" } } : {}),
				...(attachments ? { attachments } : {}),
			},
			now - ageMin * 60_000,
		);

	// All threads are ≥1 day old (in MINUTES) so the chat entities sort BELOW
	// the now-stamped notes/tasks in the Database "all vault items" grid.
	conversation("mkt_conv_invoice", "Invoice wording for Harbor", 7200);
	conversation("mkt_conv_names", "Coffee-line name ideas", 4320);
	conversation("mkt_conv_meridian", "Summarise the Meridian interviews", 2880);

	// The active thread (newest conversation) — a full, on-brand transcript.
	conversation("mkt_conv_brief", "Tighten the Harbor brief", 1440);
	msgSeq = 0;
	message(
		"mkt_conv_brief",
		"user",
		"Read my Harbor & Co brand brief and pull out the three words the tone should hit.",
		1500,
	);
	message(
		"mkt_conv_brief",
		"assistant",
		"From the brief, the tone lands on three words: crafted, honest, and generous. " +
			'"Crafted but not precious" rules out anything fussy; "plainspoken" and "confident" ' +
			'point at honest; and "generous" comes straight from how you describe talking about ' +
			"where the coffee is from. I'd lead the wordmark exploration with those three.",
		1495,
	);
	message("mkt_conv_brief", "user", "Good. Draft a one-line studio intro for the deck.", 1485);
	message(
		"mkt_conv_brief",
		"assistant",
		"Here's one: \"Northbound is a small design studio for people who care how things are " +
			'made." Want a couple of alternates — one warmer, one more technical?',
		1480,
	);
	message(
		"mkt_conv_brief",
		"user",
		"Perfect. Now write the one-page positioning doc we can hand to the client.",
		1470,
	);
	// The artifact: a real Note the agent "created", attached to its reply as a
	// clickable document link (Message/v1 `attachments`).
	mk("mkt_n_positioning", NOTE_TYPE, NOTES_APP, {
		title: "Harbor & Co — Positioning",
		icon: emoji("📄"),
		body: noteBody([
			"In one line — Coffee for people who care where it comes from, and how it's made.",
			"Who it's for — Curious drinkers moving from the supermarket shelf to something they can trace. They don't need to be experts; they want to be let in.",
			"Voice — Crafted, honest, generous. Plainspoken, never precious. A little nautical, never rope-and-anchor.",
			"What we're making — A wordmark, a flexible mark, a roast-level colour system, and a packaging family across Light / Medium / Dark.",
		]),
		values: {},
		createdAt: now - DAY,
		updatedAt: now - DAY,
	});
	message(
		"mkt_conv_brief",
		"assistant",
		"Done — I've drafted the one-pager and saved it as a document. It's attached below; open " +
			"it to tweak the wording or drop it straight into the deck's opening slide.",
		1465,
		[
			{
				kind: "entity",
				ref: "mkt_n_positioning",
				label: "Harbor & Co — Positioning",
				entityType: NOTE_TYPE,
			},
		],
	);

	return {
		seeded: true,
		counts: {
			companies: companies.length + 1,
			people: people.length,
			projects: projects.length,
			tasks: tasks.length,
			events: events.length,
			notes: 5,
			conversations: 4,
		},
	};
}

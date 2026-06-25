/**
 * Dev-only seeder for a coherent **cross-app object set** in the real
 * `entities.db` (NOT a kv silo, NOT an in-memory demo). One shared
 * object space, surfaced by every app as its own view:
 *
 *   - Calendar — the dated `Task/v1` (`scheduledAt`/`dueAt`) + `Event/v1`
 *   - Database — every type as grid / list / board / kanban / calendar
 *     (`buildVaultLists` derives a List per type + "All vault items")
 *   - Graph    — the entities + the seeded links (task→project, the
 *     note→task/project mention edges derived from note bodies)
 *   - Notes    — the `Note/v1` objects with real bodies
 *   - Journal  — the date-titled note
 *
 * Written through the same `EntitiesRepository` the entities service and
 * the `vaultEntities` aggregator read, so it is genuinely "real data".
 *
 * **Safety / idempotence:** gated on the seed's **own marker** (the
 * `seed_proj_launch` row), NOT whole-db emptiness — so it still
 * populates a vault that already has the user's real/migrated entities
 * (e.g. Notes migrated into `entities.db` by 9.3.5.N-notes.3), while a
 * re-run is a no-op (marker present → skip). All rows use stable
 * `seed_*` ids in their own namespace, so it only ever ADDS the demo
 * set and never reads, mutates, or deletes a user's data. Timestamps
 * anchor to `now` so dated items always land in the visible calendar
 * window regardless of when dev launches.
 */

import { COMPANY_TYPE } from "../entities/company-migration";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import type { VaultSession } from "../vault/session";

const TASK_TYPE = "brainstorm/Task/v1";
const PROJECT_TYPE = "brainstorm/Project/v1";
const EVENT_TYPE = "brainstorm/Event/v1";
const NOTE_TYPE = "io.brainstorm.notes/Note/v1";
const PERSON_TYPE = "brainstorm/Person/v1";
const COMPANY_BRAINSTORM = "seed_company_brainstorm";
const COMPANY_ACME = "seed_company_acme";
const TASK_IN_PROJECT_LINK = "brainstorm/Task/in-project";

const TASKS_APP = "io.brainstorm.tasks";
const CALENDAR_APP = "io.brainstorm.calendar";
const NOTES_APP = "io.brainstorm.notes";
// Contacts is a curated type-List, not an app — `createdBy` is just
// provenance; the Database app derives the People List from the type.
const CONTACTS_PROV = "io.brainstorm.contacts";

const YEAR = 365 * 86_400_000;

const DAY = 86_400_000;

export type SeedEntitiesResult = {
	seeded: boolean;
	counts?: {
		tasks: number;
		events: number;
		notes: number;
		projects: number;
		links: number;
		people: number;
	};
};

/** A real Lexical `SerializedEditorState`: one paragraph of text plus
 *  optional inline mention chips. Must be a *valid* editor state — the
 *  Notes app now hydrates an actual Lexical editor from `body`, so a
 *  root without `type:"root"` (or nodes missing the required fields)
 *  makes `parseEditorState` throw `type "undefined" + not found` and the
 *  document opens blank. The shape still satisfies the generic
 *  `extract-note-references` walker, so `aggregateSharedEntities` keeps
 *  deriving the note→target edges (9.3.5.N-notes.3a). The leading
 *  TitleNode is intentionally absent — `migrateTitleIntoBody` folds the
 *  stored `title` in on read, exactly as it does for real notes. */
function noteBody(
	text: string,
	mentions: Array<{ entityId: string; entityType: string; label: string }> = [],
): unknown {
	const textNode = (t: string) => ({
		type: "text",
		text: t,
		detail: 0,
		format: 0,
		mode: "normal",
		style: "",
		version: 1,
	});
	const children: unknown[] = [textNode(text)];
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
	return {
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
					children,
				},
			],
		},
	};
}

function isoDateKey(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local time today at `hour`:00, as epoch ms. */
function todayAt(now: number, hour: number): number {
	const d = new Date(now);
	d.setHours(hour, 0, 0, 0);
	return d.getTime();
}

/**
 * The go-to-market launch plan as a real project of `Task/v1` issues and
 * `parentId`-nested sub-issues, so the team tracks its own beta launch in
 * Tasks / Database / Graph like any other project. Each issue is a launch
 * workstream; each sub-issue is a concrete action with a descriptive
 * `notes` body. The narrative lives in.
 *
 * Own marker (`seed_proj_beta_launch`) so it lands even on a vault seeded
 * before this project existed; returns whether it added rows.
 */
function seedBetaLaunchProject(repo: EntitiesRepository, now: number): boolean {
	const projectId = "seed_proj_beta_launch";
	if (repo.get(projectId)) return false;

	const mk = (id: string, type: string, properties: Record<string, unknown>) =>
		repo.create({ id, type, createdBy: TASKS_APP, properties, now, dekId: null });

	const milestoneAt = new Date("2026-09-01T00:00:00Z").getTime();

	mk(projectId, PROJECT_TYPE, {
		name: "Public Beta Launch — GTM",
		description:
			"Go-to-market & operational launch plan for the 2026-09-01 public beta (a free, " +
			"encrypted multi-device core — not GA). Differentiation: local-first + end-to-end " +
			"encrypted + sovereign identity. Wedge: one-click switch-in from Notion / Obsidian. " +
			"No AI in beta — do not lead with AI. Full narrative in docs/ops/launch-plan.md.",
		statusKey: "active",
		milestoneAt,
		colorHint: "#6366f1",
		createdAt: now,
		updatedAt: now,
	});

	type Sub = {
		id: string;
		name: string;
		notes: string;
		priority: string;
		statusKey?: string;
		dueInDays?: number;
	};
	type Issue = {
		id: string;
		name: string;
		notes: string;
		priority: string;
		statusKey?: string;
		subs: Sub[];
	};

	const issues: Issue[] = [
		{
			id: "seed_bl_dist",
			name: "Distribution & delivery",
			priority: "high",
			notes:
				"Get a signed, trustworthy desktop download in front of users. v1 distribution is " +
				"direct signed installers (macOS / Windows / Linux + arm64) — app stores are v2, so we " +
				"host the binaries and the update feed ourselves.",
			subs: [
				{
					id: "seed_bl_dist_certs",
					name: "Procure code-signing certificates (Apple Dev + Windows EV)",
					priority: "critical",
					dueInDays: 14,
					notes:
						"Procure the Apple Developer ID cert and a Windows EV code-signing cert (DQ-13.1-A/B). " +
						"Hard blocker — notarized signed installers are non-negotiable for a public desktop " +
						"download, and the 13.1 CI signing path is already built and env-var-gated waiting on " +
						"these. EV has identity-verification lead time, so start immediately.",
				},
				{
					id: "seed_bl_dist_hosting",
					name: "Stand up signed-installer release hosting + CDN",
					priority: "high",
					notes:
						"CDN-backed hosting for the signed .dmg / .exe / AppImage (incl. arm64) builds the 13.1 CI " +
						"matrix produces, behind stable versioned URLs.",
				},
				{
					id: "seed_bl_dist_feed",
					name: "Wire the in-product update-feed host URL",
					priority: "high",
					notes:
						"Serve the release JSON at the real BRAINSTORM_UPDATE_FEED_URL host. The in-product " +
						"manual-download updater (13.6) is built and only needs its feed endpoint.",
				},
				{
					id: "seed_bl_dist_page",
					name: "Build the download page (OS auto-detect, checksums)",
					priority: "medium",
					notes:
						"Download page with OS auto-detect, per-artifact checksums, and clear 'what is this / " +
						"system requirements / this is a beta' framing.",
				},
				{
					id: "seed_bl_dist_gate",
					name: "Decide the download gate model (open vs. invite drip)",
					priority: "medium",
					notes:
						"Open download vs. invite/waitlist drip. A drip warms the list and controls load on the " +
						"sync relays during the first days.",
				},
			],
		},
		{
			id: "seed_bl_web",
			name: "Web properties",
			priority: "high",
			notes:
				"The public-facing web surfaces beyond the app itself. Everything hangs off getbrainstorm.online.",
			subs: [
				{
					id: "seed_bl_web_site",
					name: "Evolve the waitlist page into the full marketing site",
					priority: "high",
					notes:
						"Grow the bare waitlist page into the full marketing site: the switch-in narrative, the " +
						"privacy/ownership story, screenshots, and the download CTA.",
				},
				{
					id: "seed_bl_web_docs",
					name: "Docs portal at docs.getbrainstorm.online",
					priority: "medium",
					notes:
						"Getting-started, the Notion and Obsidian migration guides (the importers exist — document " +
						"them), and a plain-language encryption explainer.",
				},
				{
					id: "seed_bl_web_status",
					name: "Status page for sync-relay uptime",
					priority: "low",
					notes: "For an encrypted-sync product an uptime status page is a trust signal, not a nicety.",
				},
				{
					id: "seed_bl_web_account",
					name: "Decide whether the beta needs the account portal",
					priority: "low",
					notes:
						"A keystore-sovereign, billing-free beta may defer the account web portal (Account-1) entirely.",
				},
			],
		},
		{
			id: "seed_bl_infra",
			name: "Email & domain infrastructure",
			priority: "critical",
			notes:
				"Cross-cutting plumbing the waitlist, support, and security disclosure all depend on. Domain " +
				"reputation warms slowly, so this is critical-path.",
			subs: [
				{
					id: "seed_bl_infra_email",
					name: "Transactional email + DMARC/SPF/DKIM on the domain",
					priority: "critical",
					dueInDays: 10,
					notes:
						"Set up transactional + inbox email on getbrainstorm.online (founder@, support@, security@) " +
						"with DMARC/SPF/DKIM configured. A 10-week-old waitlist with zero contact is a cold list — " +
						"you need a sending domain in good standing before you mail it.",
				},
				{
					id: "seed_bl_infra_handles",
					name: "Lock social handles + GitHub / npm orgs",
					priority: "high",
					dueInDays: 7,
					notes:
						"Reserve @getbrainstorm across X / Bluesky / Mastodon and the GitHub + npm orgs. " +
						"Handle-squatting is irreversible.",
				},
				{
					id: "seed_bl_infra_subdomains",
					name: "Plan the subdomain map",
					priority: "medium",
					notes:
						"Lay out docs., status., and the update-feed host up front so links and the in-product " +
						"updater point at stable hosts.",
				},
			],
		},
		{
			id: "seed_bl_legal",
			name: "Legal, compliance & trust",
			priority: "high",
			notes:
				"Disproportionately important for a privacy product — the trust pages are part of the pitch, " +
				"not boilerplate.",
			subs: [
				{
					id: "seed_bl_legal_privacy",
					name: "Privacy policy + terms of service",
					priority: "high",
					notes:
						"Keep the privacy policy genuinely minimal-collection — anything else contradicts the " +
						"local-first positioning.",
				},
				{
					id: "seed_bl_legal_encryption",
					name: '"What we can and can\'t see" encryption explainer',
					priority: "high",
					notes:
						"Plain-language page explaining the end-to-end encryption model (the relay sees only " +
						"ciphertext). For this audience the page is marketing.",
				},
				{
					id: "seed_bl_legal_security",
					name: "security@ + vulnerability-disclosure policy",
					priority: "medium",
					notes:
						"We ship a real crypto surface — invite researchers to probe it via a disclosure policy " +
						"rather than have them go public cold.",
				},
				{
					id: "seed_bl_legal_eula",
					name: "Beta EULA / data-handling disclaimer",
					priority: "medium",
					notes: "It's beta: a clear data-loss disclaimer and no-SLA statement.",
				},
				{
					id: "seed_bl_legal_license",
					name: "Open-source license decision",
					priority: "low",
					notes:
						"Decide the OSS license posture if any code goes public — it shapes both the narrative and " +
						"the community story.",
				},
			],
		},
		{
			id: "seed_bl_support",
			name: "Support & feedback ops",
			priority: "medium",
			notes: "A beta needs a fast feedback loop, not a heavy help desk.",
			subs: [
				{
					id: "seed_bl_support_intake",
					name: "Wire in-product crash/feedback intake to real triage",
					priority: "medium",
					notes:
						"Connect the in-product feedback/crash intake (Feedback-1/2/3 + the 14.24a admin " +
						"groundwork) to a real inbox and triage queue (BugTrack-1).",
				},
				{
					id: "seed_bl_support_channel",
					name: "Community + email support channel",
					priority: "medium",
					notes:
						"A lightweight community + email channel (e.g. Discord) for fast back-and-forth with beta users.",
				},
				{
					id: "seed_bl_support_changelog",
					name: "Public changelog / roadmap",
					priority: "low",
					notes: "Converts the implementation plan into a trust and engagement asset.",
				},
			],
		},
		{
			id: "seed_bl_analytics",
			name: "Analytics & observability",
			priority: "medium",
			notes: "Measure activation and reliability without contradicting the privacy pitch.",
			subs: [
				{
					id: "seed_bl_analytics_product",
					name: "Privacy-respecting product analytics",
					priority: "medium",
					notes:
						"Opt-in, Plausible-style product analytics. Anything surveillance-shaped undermines the " +
						"entire positioning.",
				},
				{
					id: "seed_bl_analytics_obs",
					name: "Sync-relay + web-property observability",
					priority: "medium",
					notes:
						"Instrument the relays and web properties (Ops-1) so launch-day load and errors are visible live.",
				},
				{
					id: "seed_bl_analytics_metrics",
					name: "Define beta success metrics",
					priority: "high",
					notes:
						"Define them now: activation = 'imported a vault'; retention = D7/D30; and the encrypted " +
						"multi-device pairing-completion rate.",
				},
			],
		},
		{
			id: "seed_bl_msg",
			name: "Positioning & messaging",
			priority: "high",
			statusKey: "doing",
			notes: "The narrative every other surface inherits. Draft locked in docs/ops/launch-plan.md.",
			subs: [
				{
					id: "seed_bl_msg_positioning",
					name: "Lock headline / subhead / three-bullet positioning",
					priority: "high",
					statusKey: "doing",
					notes:
						"Headline 'Your notes. Your keys. Your machine.', the subhead, and three proof bullets " +
						"(encrypted E2E / local-first / switch-in) — consistent across every surface.",
				},
				{
					id: "seed_bl_msg_kit",
					name: "Press & launch kit (screenshots, demo video, brand assets)",
					priority: "high",
					notes:
						"Screenshots, a 60–90s demo video of the import → encrypted → multi-device moment, brand " +
						"assets, and the founder story.",
				},
			],
		},
		{
			id: "seed_bl_smm",
			name: "Content & SMM",
			priority: "high",
			notes: "Acquisition. The live waitlist page is the most urgent fix — it's bare today.",
			subs: [
				{
					id: "seed_bl_smm_waitlist",
					name: "Rewrite the live waitlist landing copy",
					priority: "critical",
					dueInDays: 5,
					notes:
						"Rewrite getbrainstorm.online with real positioning copy. Today it's just 'Brainstorm' + an " +
						"email field — no value prop, so signups are low-intent and won't convert at launch. Change " +
						"the CTA to 'Join the private beta'.",
				},
				{
					id: "seed_bl_smm_segment",
					name: 'Add the "what do you use today?" segmentation field',
					priority: "high",
					dueInDays: 6,
					notes:
						"One optional waitlist field (Notion / Obsidian / Apple Notes / Roam-Logseq / Nothing yet / " +
						"Other). Enables launch-email segmentation and lets you quote real demand ('70% of our " +
						"waitlist is leaving Notion').",
				},
				{
					id: "seed_bl_smm_nurture",
					name: "Wire confirmation + nurture email sequence",
					priority: "high",
					notes:
						"Confirmation email plus a nurture cadence (≥1 build-in-public update every two weeks) so the " +
						"waitlist stays warm through to launch.",
				},
				{
					id: "seed_bl_smm_bip",
					name: "Build-in-public cadence across socials + communities",
					priority: "medium",
					notes:
						"Run a build-in-public cadence on X / Bluesky / Mastodon and seed the aligned communities — " +
						"r/selfhosted, r/ObsidianMD, Lobsters, and the local-first / CRDT crowd (we use Yjs — they'll care).",
				},
				{
					id: "seed_bl_smm_narrative",
					name: "Founding-narrative posts",
					priority: "medium",
					notes:
						"'Why we built an OS, not an app', 'what end-to-end encryption actually means for your notes', " +
						"and the migration story.",
				},
				{
					id: "seed_bl_smm_outreach",
					name: "Creator / influencer outreach",
					priority: "medium",
					notes:
						"Line up aligned creators (local-first, privacy, PKM / tools-for-thought) for launch-day amplification.",
				},
			],
		},
		{
			id: "seed_bl_launch",
			name: "Launch-day playbook",
			priority: "high",
			notes: "The coordinated drop and the hours around it.",
			subs: [
				{
					id: "seed_bl_launch_ph",
					name: "Product Hunt prep (hunter, assets, schedule)",
					priority: "high",
					notes: "Line up a hunter, build the assets, and schedule the post.",
				},
				{
					id: "seed_bl_launch_hn",
					name: "Show HN post",
					priority: "high",
					notes: "The encryption + local-first angle is HN-native; lead with it.",
				},
				{
					id: "seed_bl_launch_drop",
					name: "Coordinated asset drop + load test",
					priority: "high",
					notes: "Demo video, landing site, and download all live and load-tested the same morning.",
				},
				{
					id: "seed_bl_launch_oncall",
					name: "On-call rotation for launch day",
					priority: "medium",
					notes: "Cover the sync relays, the download CDN, and crash intake live.",
				},
				{
					id: "seed_bl_launch_week1",
					name: "Week-1 learnings post",
					priority: "low",
					notes: "Sustains the build-in-public momentum and the feedback loop after launch.",
				},
			],
		},
	];

	const link = (id: string) =>
		repo.putLink({
			id: `seed_lnk_${id}_proj`,
			sourceEntityId: id,
			destEntityId: projectId,
			linkType: TASK_IN_PROJECT_LINK,
			createdAt: now,
		});

	for (const issue of issues) {
		mk(issue.id, TASK_TYPE, {
			name: issue.name,
			notes: issue.notes,
			priority: issue.priority,
			statusKey: issue.statusKey ?? "todo",
			projectId,
			parentId: null,
			createdAt: now,
			updatedAt: now,
		});
		link(issue.id);
		for (const sub of issue.subs) {
			mk(sub.id, TASK_TYPE, {
				name: sub.name,
				notes: sub.notes,
				priority: sub.priority,
				statusKey: sub.statusKey ?? "todo",
				projectId,
				parentId: issue.id,
				...(sub.dueInDays !== undefined ? { dueAt: now + sub.dueInDays * DAY } : {}),
				createdAt: now,
				updatedAt: now,
			});
			link(sub.id);
		}
	}

	return true;
}

export async function seedDemoEntities(session: VaultSession): Promise<SeedEntitiesResult> {
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	const now = Date.now();

	// The GTM beta-launch project has its own marker, so it lands even on a
	// vault seeded before it existed (and a re-run is a no-op).
	const betaAdded = seedBetaLaunchProject(repo, now);

	// Idempotent marker-gate: skip the original cross-app demo set only if
	// THIS seed already ran (its project row exists). A non-empty vault with
	// the user's own / migrated entities still gets the demo set — the seed
	// lives in its own `seed_*` id namespace and only ever adds rows.
	const projectId = "seed_proj_launch";
	if (repo.get(projectId)) return { seeded: betaAdded };

	const mk = (id: string, type: string, createdBy: string, properties: Record<string, unknown>) =>
		// Seeder rows are dev-only and shell-stamped; per-entity DEK
		// (Stage 10.1) is reserved for entities created through the
		// entities IPC service.
		repo.create({ id, type, createdBy, properties, now, dekId: null });

	// ── Project (the idempotency marker — created first) ───────────────
	mk(projectId, PROJECT_TYPE, TASKS_APP, {
		name: "Brainstorm Launch",
		statusKey: "active",
		createdAt: now - 14 * DAY,
		updatedAt: now,
	});

	// ── Tasks (dated → Calendar; varied status/priority → board/kanban) ─
	const tasks: Array<[string, Record<string, unknown>]> = [
		[
			"seed_task_1",
			{
				name: "Draft launch announcement",
				priority: "high",
				statusKey: "doing",
				scheduledAt: now + DAY,
				dueAt: now + 2 * DAY,
			},
		],
		[
			"seed_task_2",
			{ name: "Record demo video", priority: "medium", statusKey: "todo", dueAt: now + 3 * DAY },
		],
		[
			"seed_task_3",
			{
				name: "Fix onboarding copy",
				priority: "low",
				statusKey: "done",
				scheduledAt: now - DAY,
				completedAt: now - DAY + 3_600_000,
			},
		],
		[
			"seed_task_4",
			{ name: "Prep Product Hunt assets", priority: "high", statusKey: "todo", dueAt: now + 5 * DAY },
		],
		[
			"seed_task_5",
			{
				name: "Security review pass",
				priority: "high",
				statusKey: "doing",
				scheduledAt: now + 2 * DAY,
			},
		],
		// Undated — proves Database shows backlog items a calendar can't.
		["seed_task_6", { name: "Backlog grooming", priority: "none", statusKey: "todo" }],
	];
	for (const [id, props] of tasks) {
		mk(id, TASK_TYPE, TASKS_APP, {
			...props,
			projectId,
			createdAt: now - 7 * DAY,
			updatedAt: now,
		});
		repo.putLink({
			id: `seed_lnk_${id}_proj`,
			sourceEntityId: id,
			destEntityId: projectId,
			linkType: TASK_IN_PROJECT_LINK,
			createdAt: now,
		});
	}

	// ── Events (start/end → Calendar spans) ────────────────────────────
	const events: Array<[string, Record<string, unknown>]> = [
		[
			"seed_evt_1",
			{ title: "Team standup", start: todayAt(now, 9), end: todayAt(now, 9) + 1_800_000 },
		],
		[
			"seed_evt_2",
			{ title: "Launch review", start: todayAt(now, 14) + 2 * DAY, end: todayAt(now, 15) + 2 * DAY },
		],
		[
			"seed_evt_3",
			{ title: "Launch day 🚀", start: todayAt(now, 0) + 5 * DAY, end: null, allDay: true },
		],
	];
	for (const [id, props] of events) {
		mk(id, EVENT_TYPE, CALENDAR_APP, { ...props, createdAt: now - 3 * DAY, updatedAt: now });
	}

	// ── Notes (real bodies; mentions → Graph edges; one date-titled) ───
	const note = (id: string, title: string, body: unknown) =>
		mk(id, NOTE_TYPE, NOTES_APP, {
			title,
			body,
			values: {},
			createdAt: now - 5 * DAY,
			updatedAt: now,
		});
	note(
		"seed_note_plan",
		"Launch plan",
		noteBody("Cut a release branch, then ship the announcement —", [
			{ entityId: "seed_task_1", entityType: TASK_TYPE, label: "Draft launch announcement" },
		]),
	);
	note(
		"seed_note_ideas",
		"Ideas backlog",
		noteBody("Network apps, marketplace polish, themes — track under", [
			{ entityId: projectId, entityType: PROJECT_TYPE, label: "Brainstorm Launch" },
		]),
	);
	note(
		`seed_note_${isoDateKey(now)}`,
		isoDateKey(now),
		noteBody("Daily journal: paired on the entities seed; Calendar + Database now populated."),
	);
	note(
		"seed_note_readme",
		"Read me first",
		noteBody("Welcome to your vault — this is sample data."),
	);

	// ── People (Contacts) — `brainstorm/Person/v1`; the Database app
	//    auto-derives an "All Person" List, so Contacts renders today.
	//    Composable props: email/phone are Text+format (multi), birthday
	//    a Date, some linked to the launch project via `links`. ───────────
	// Companies are real `Company/v1` entities so people connect to a shared
	// hub node via the `company` reference (not an inferred shared-string edge).
	const companies: Array<[string, string]> = [
		[COMPANY_BRAINSTORM, "Brainstorm"],
		[COMPANY_ACME, "Acme Press"],
	];
	for (const [id, name] of companies) {
		mk(id, COMPANY_TYPE, CONTACTS_PROV, { name, createdAt: now - 14 * DAY, updatedAt: now });
	}

	const people: Array<[string, Record<string, unknown>]> = [
		[
			"seed_person_ada",
			{
				name: "Ada Okafor",
				email: ["ada@brainstorm.app"],
				phone: ["+1 555 0142"],
				company: COMPANY_BRAINSTORM,
				role: "Founder",
				birthday: now - 31 * YEAR,
				links: [projectId],
			},
		],
		[
			"seed_person_lin",
			{
				name: "Lin Zhao",
				email: ["lin@brainstorm.app", "lin.zhao@personal.example"],
				phone: ["+1 555 0188"],
				company: COMPANY_BRAINSTORM,
				role: "Design",
				birthday: now - 29 * YEAR,
				links: [projectId],
			},
		],
		[
			"seed_person_mara",
			{
				name: "Mara Silva",
				email: ["mara@example.com"],
				company: COMPANY_ACME,
				role: "Launch partner",
				birthday: now - 41 * YEAR,
			},
		],
		["seed_person_kenji", { name: "Kenji Ito", email: ["kenji@example.com"], role: "Advisor" }],
	];
	for (const [id, props] of people) {
		mk(id, PERSON_TYPE, CONTACTS_PROV, { ...props, createdAt: now - 10 * DAY, updatedAt: now });
	}

	// ── Brainstorm Cloud (control-plane) tracking ──────────────────────
	// The commercial backend lives in its own out-of-product repo
	// (../cloud) but is tracked AS vault entities so the infra
	// work shows up in Tasks / Database / Graph like any other project —
	// the team dogfoods its own tracker. Mirrors brainstorm-cloud/.
	// Undated (backlog) so the Calendar demo window is unaffected.
	const cloudProjectId = "seed_proj_cloud";
	mk(cloudProjectId, PROJECT_TYPE, TASKS_APP, {
		name: "Brainstorm Cloud (control plane)",
		statusKey: "active",
		createdAt: now - DAY,
		updatedAt: now,
	});
	const cloudTasks: Array<[string, Record<string, unknown>]> = [
		[
			"seed_task_cloud_bootstrap",
			{
				name: "Cloud: bootstrap workspace (bun + turbo + biome)",
				priority: "high",
				statusKey: "doing",
			},
		],
		[
			"seed_task_cloud_contract",
			{
				name: "Cloud: api-client entitlement-token contract",
				priority: "high",
				statusKey: "done",
				completedAt: now,
			},
		],
		[
			"seed_task_cloud_billing",
			{ name: "Cloud: billing-edge (Axum + Postgres + Stripe)", priority: "high", statusKey: "todo" },
		],
		[
			"seed_task_cloud_surfaces",
			{ name: "Cloud: account / dev-portal / admin surfaces", priority: "medium", statusKey: "todo" },
		],
		[
			"seed_task_cloud_docs",
			{ name: "Cloud: docs portal (static render)", priority: "low", statusKey: "todo" },
		],
	];
	for (const [id, props] of cloudTasks) {
		mk(id, TASK_TYPE, TASKS_APP, {
			...props,
			projectId: cloudProjectId,
			createdAt: now - DAY,
			updatedAt: now,
		});
		repo.putLink({
			id: `seed_lnk_${id}_proj`,
			sourceEntityId: id,
			destEntityId: cloudProjectId,
			linkType: TASK_IN_PROJECT_LINK,
			createdAt: now,
		});
	}

	return {
		seeded: true,
		counts: {
			tasks: tasks.length + cloudTasks.length,
			events: events.length,
			notes: 4,
			projects: 2,
			links: tasks.length + cloudTasks.length,
			people: people.length,
		},
	};
}

/** Hard-delete every `seed_*` entity (and its incident links + change-log
 *  entries) so a subsequent `seedDemoEntities` rebuilds a fresh set. Used
 *  by the dev `dev:reseed-vault` IPC; never run in production. */
export async function clearSeedEntities(session: VaultSession): Promise<{ deleted: number }> {
	const db = await session.dataStores.open("entities");
	const now = Date.now();
	const seedRows = db.prepare("SELECT id FROM entities WHERE id GLOB 'seed_*'").all() as Array<{
		id: string;
	}>;
	const repo = new EntitiesRepository(db);
	let deleted = 0;
	for (const { id } of seedRows) {
		repo.softDelete(id, now);
		if (repo.hardDelete(id)) deleted += 1;
	}
	// Catch stragglers (e.g. links pointing at already-deleted seeds).
	db
		.prepare("DELETE FROM links WHERE source_entity_id GLOB 'seed_*' OR dest_entity_id GLOB 'seed_*'")
		.run();
	db.prepare("DELETE FROM change_log WHERE entity_id GLOB 'seed_*'").run();
	return { deleted };
}

/** Dev convenience: clear the previously-seeded `seed_*` rows and run
 *  the seeder again so the active vault picks up any seed-code edits. */
export async function reseedDemoEntities(session: VaultSession): Promise<SeedEntitiesResult> {
	await clearSeedEntities(session);
	return seedDemoEntities(session);
}

/**
 * Capture-only scripted provider (demo mode).
 *
 * The Agent-11 propose→approve reel needs the agent to *generate* proposals on
 * camera, but the promo rig is deterministic and model-free by design (it seeds
 * every other scene through the app's own dev handlers). This provider is that
 * seam for the agent scene: gated behind the `BRAINSTORM_DEMO_AGENT` env flag
 * (never registered in normal dev/prod), it returns a fixed, scripted sequence
 * of `propose-*` tool calls followed by a final answer.
 *
 * Crucially it drives the **real** {@link runAgentLoop}: each `generate` returns
 * the next scripted reply, which the genuine `parseAgentReply` →
 * `makeDispatchTool` → `buildProposal` → proposal-tray path parses, dispatches,
 * and stages. Only the "model" is scripted — every pixel downstream of it is the
 * real pipeline, so the reel shows the true propose→approve UX, reproducibly.
 */

import {
	type AiChatMessage,
	type AiGenerateRequest,
	type AiGenerateResult,
	MessageRole,
} from "@brainstorm-os/sdk-types";
import { type ModelProvider, buildUsage } from "./provider";

export const DEMO_AGENT_PROVIDER_ID = "demo";

/** The scripted turn — a "follow-up after a client call" scenario matching the
 *  VID-agent-team foundations cut. Each entry is one loop iteration's reply, in
 *  the loop's JSON tool-call protocol; the last is the final answer. Dates are
 *  fixed so the reel is byte-identical every render. */
export const DEMO_AGENT_SCRIPT: readonly string[] = [
	JSON.stringify({
		tool: "propose-contact",
		args: {
			name: "Priya Rao",
			email: "priya@meridian.co",
			company: "Meridian",
			notes: "Q3 retainer lead — met on the intro call.",
		},
	}),
	JSON.stringify({
		tool: "propose-task",
		args: {
			title: "Follow up with Priya on the Q3 retainer",
			dueDate: "2026-07-30",
			notes: "Send the scope recap and the pricing options we discussed.",
		},
	}),
	JSON.stringify({
		tool: "propose-event",
		args: {
			title: "Q3 retainer check-in with Meridian",
			start: "2026-07-31T15:00:00Z",
			notes: "30-minute call to walk through the proposal.",
		},
	}),
	JSON.stringify({
		final:
			"I've drafted a contact for Priya, a follow-up task, and a check-in event. Review and approve the ones you want to keep — nothing is saved to your vault until you do.",
		citations: [],
	}),
];

/** Vault-relative paths, id and name of the app the AppForge script drafts.
 *  Exported so the capture rig and the tests address it by name rather than by
 *  a repeated string literal. */
export const DEMO_AGENT_APPFORGE_APP_ID = "studio.northbound.milestones";
export const DEMO_AGENT_APPFORGE_APP_NAME = "Milestones";
export const DEMO_AGENT_APPFORGE_MANIFEST_PATH = "milestones/manifest.json";
export const DEMO_AGENT_APPFORGE_INDEX_PATH = "milestones/index.html";

/** The one type the drafted app reads, and the capability that scopes it — the
 *  SAME narrow grant the app the user hand-writes in the episode uses, which is
 *  the point: two independently authored apps, one scope, one broker. */
const APPFORGE_ENTITY_TYPE = "brainstorm/Project/v1";
const APPFORGE_CAPABILITY = `entities.read:${APPFORGE_ENTITY_TYPE}`;

/** The drafted `manifest.json`. `sdk: "1"` is not decoration — a manifest
 *  without it fails `validateManifest`, which greys out the vault picker's
 *  Install button and silently kills the act. */
const APPFORGE_MANIFEST = `{
  "id": "${DEMO_AGENT_APPFORGE_APP_ID}",
  "name": "${DEMO_AGENT_APPFORGE_APP_NAME}",
  "version": "1.0.0",
  "sdk": "1",
  "description": "Every client project's next milestone, on one timeline.",
  "entry": "index.html",
  "capabilities": ["${APPFORGE_CAPABILITY}"]
}
`;

/** The drafted `index.html` — a genuine, working, no-build app.
 *
 *  It must be genuinely real: the episode's claim is that the agent writes an
 *  app, not a stub, so these bytes install through `apps:install-from-vault`
 *  and render the vault's actual `brainstorm/Project/v1` rows — a countdown to
 *  the soonest milestone plus a lead-time track for the rest. Deliberately a
 *  DIFFERENT product from the hand-written board in the same episode (that one
 *  is a status board ordered by name; this one is a date-ordered timeline), so
 *  the two apps in the closing grid are two apps, not one app twice.
 *
 *  Platform contract it leans on: classic `<script>` (ES modules are blocked
 *  over `file://`), `window.brainstorm` exposed before any page script runs,
 *  and the shell-injected design tokens — every `var(--…)` below is a real
 *  token from `packages/tokens`. */
const APPFORGE_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:"
    />
    <title>Milestones</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        font: 14px/1.5 system-ui, sans-serif;
        color: var(--color-text-primary);
        background: var(--color-background-primary);
      }
      .app-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        box-sizing: border-box;
        border-bottom: 1px solid var(--color-border-subtle);
        background: var(--color-background-elevated);
        -webkit-app-region: drag;
      }
      .app-header__title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
      }
      #grant {
        font-size: 11px;
        color: var(--color-text-tertiary);
      }
      .next {
        display: flex;
        align-items: baseline;
        gap: var(--space-4);
        margin: var(--space-5) var(--space-5) var(--space-4);
        padding: var(--space-4) var(--space-5);
        border: 1px solid var(--color-border-subtle);
        border-left: 4px solid var(--color-state-info);
        border-radius: var(--radius-lg);
        background: var(--color-background-elevated);
      }
      .next__days {
        font-size: 44px;
        font-weight: 600;
        line-height: 1;
      }
      .next__unit {
        font-size: 12px;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--color-text-tertiary);
      }
      .next__name {
        font-size: 17px;
        font-weight: 600;
      }
      .track {
        flex: 1;
        display: grid;
        grid-auto-rows: minmax(72px, 1fr);
        gap: var(--space-3);
        padding: 0 var(--space-5) var(--space-5);
      }
      .lane {
        display: grid;
        grid-template-columns: 34px 1fr auto;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border: 1px solid var(--color-border-subtle);
        border-radius: var(--radius-lg);
        background: var(--color-background-elevated);
        opacity: 0;
        transform: translateY(10px);
        animation: rise 400ms var(--motion-easing-decelerated) forwards;
        transition:
          border-color var(--motion-duration-fast) var(--motion-easing-standard),
          background var(--motion-duration-fast) var(--motion-easing-standard);
      }
      .lane:hover {
        border-color: var(--color-border-strong);
        background: var(--color-surface-raised);
      }
      .lane--none {
        opacity: 0;
        animation: fade 400ms var(--motion-easing-decelerated) forwards;
      }
      @keyframes rise {
        to {
          opacity: 1;
          transform: none;
        }
      }
      @keyframes fade {
        to {
          opacity: 0.55;
        }
      }
      .lane__icon {
        font-size: 22px;
        text-align: center;
      }
      .lane__mid {
        display: grid;
        gap: var(--space-1);
        min-width: 0;
      }
      .lane__name {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
      }
      .lane__status {
        margin: 0;
        font-size: 11px;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--color-text-tertiary);
      }
      .bar {
        height: 6px;
        border-radius: var(--radius-full);
        background: var(--color-border-subtle);
        overflow: hidden;
      }
      .bar__fill {
        display: block;
        height: 100%;
        border-radius: var(--radius-full);
      }
      .lane__when {
        text-align: right;
        white-space: nowrap;
      }
      .lane__days {
        font-size: 17px;
        font-weight: 600;
      }
      .lane__date {
        font-size: 11px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--color-text-tertiary);
      }
    </style>
  </head>
  <body>
    <header class="app-header">
      <div class="app-header__left">
        <h1 class="app-header__title">Milestones</h1>
      </div>
      <div class="app-header__right"><span id="grant"></span></div>
    </header>
    <section class="next" id="next"></section>
    <main class="track" id="track"></main>
    <script>
      (function () {
        var api = window.brainstorm;
        var track = document.getElementById("track");
        var next = document.getElementById("next");

        document.getElementById("grant").textContent =
          "vault access: " +
          (api.capabilities
            .filter(function (cap) {
              return cap.indexOf("entities.") === 0;
            })
            .join(", ") || "none");

        function days(at) {
          return Math.ceil((at - Date.now()) / 86400000);
        }

        function dateLabel(at) {
          return new Date(at).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          });
        }

        function el(tag, className, text) {
          var node = document.createElement(tag);
          if (className) node.className = className;
          if (text !== undefined) node.textContent = text;
          return node;
        }

        function lane(row, widest) {
          var p = row.properties || {};
          var at = p.milestoneAt;
          var dated = typeof at === "number";
          var node = el("article", dated ? "lane" : "lane lane--none");
          node.appendChild(el("div", "lane__icon", (p.icon && p.icon.value) || "•"));

          var mid = el("div", "lane__mid");
          mid.appendChild(el("h2", "lane__name", String(p.name || "Untitled")));
          mid.appendChild(el("p", "lane__status", String(p.statusKey || "unknown")));
          var bar = el("div", "bar");
          var fill = el("span", "bar__fill");
          fill.style.width = dated
            ? Math.max(6, Math.round((days(at) / widest) * 100)) + "%"
            : "0%";
          fill.style.background = String(p.colorHint || "var(--color-state-info)");
          bar.appendChild(fill);
          mid.appendChild(bar);
          node.appendChild(mid);

          var when = el("div", "lane__when");
          when.appendChild(el("div", "lane__days", dated ? days(at) + "d" : "—"));
          when.appendChild(
            el("div", "lane__date", dated ? dateLabel(at) : "no milestone")
          );
          node.appendChild(when);
          return node;
        }

        function render(rows) {
          var dated = rows
            .filter(function (row) {
              return typeof (row.properties || {}).milestoneAt === "number";
            })
            .sort(function (a, b) {
              return a.properties.milestoneAt - b.properties.milestoneAt;
            });
          var undated = rows.filter(function (row) {
            return typeof (row.properties || {}).milestoneAt !== "number";
          });
          var widest = dated.length ? days(dated[dated.length - 1].properties.milestoneAt) : 1;

          next.textContent = "";
          if (dated.length) {
            var soon = dated[0].properties;
            var count = el("div");
            count.appendChild(el("div", "next__days", days(soon.milestoneAt) + ""));
            count.appendChild(el("div", "next__unit", "days away"));
            next.appendChild(count);
            var who = el("div");
            who.appendChild(el("div", "next__name", String(soon.name)));
            who.appendChild(el("div", "next__unit", "next milestone · " + dateLabel(soon.milestoneAt)));
            next.appendChild(who);
          } else {
            next.appendChild(el("div", "next__name", "No dated milestones"));
          }

          track.textContent = "";
          dated.concat(undated).forEach(function (row, index) {
            var node = lane(row, widest);
            node.style.animationDelay = index * 90 + "ms";
            track.appendChild(node);
          });
        }

        api.services.entities
          .query({ type: "${APPFORGE_ENTITY_TYPE}" })
          .then(render)
          .catch(function (error) {
            track.appendChild(el("p", "lane__date", "Could not read projects: " + error.message));
          });
      })();
    </script>
  </body>
</html>
`;

/** AppForge-3 — the "the agent builds an app" act: it drafts a
 *  `manifest.json` + an `index.html` as `propose-code-file` cards the user
 *  approves into the vault, from where they install like any other app. Same
 *  capture-only contract as the default script; selected via
 *  `BRAINSTORM_DEMO_AGENT=appforge`.
 *
 *  The drafted manifest MUST satisfy `validateManifest` — the whole point of
 *  the act is that the approved files then install through
 *  `apps:install-from-vault`, and the vault picker greys out any candidate
 *  whose manifest is invalid. `demo-agent-provider.test.ts` pins that, and
 *  pins the capability line too: an app that asks for nothing proves nothing
 *  about the broker. */
export const DEMO_AGENT_APPFORGE_SCRIPT: readonly string[] = [
	JSON.stringify({
		tool: "propose-code-file",
		args: {
			path: DEMO_AGENT_APPFORGE_MANIFEST_PATH,
			language: "json",
			content: APPFORGE_MANIFEST,
		},
	}),
	JSON.stringify({
		tool: "propose-code-file",
		args: {
			path: DEMO_AGENT_APPFORGE_INDEX_PATH,
			language: "html",
			content: APPFORGE_INDEX_HTML,
		},
	}),
	JSON.stringify({
		final:
			"I've drafted Milestones — a manifest that asks only to read your projects, and a page that puts each one's next milestone on a timeline. Review the code and approve it to add the files to your vault; nothing is saved until you do.",
		citations: [],
	}),
];

/** The env value (`BRAINSTORM_DEMO_AGENT=<value>`) that selects the AppForge
 *  code-file script; any other truthy value keeps the default follow-up reel. */
export const DEMO_AGENT_APPFORGE_MODE = "appforge";

/** Resolve which script a `BRAINSTORM_DEMO_AGENT` value drives. Pure. */
export function demoScriptForMode(mode: string | undefined): readonly string[] {
	return mode === DEMO_AGENT_APPFORGE_MODE ? DEMO_AGENT_APPFORGE_SCRIPT : DEMO_AGENT_SCRIPT;
}

/** The script step this turn is on = how many tool acks are already fed back
 *  (the loop appends one `tool`-role message per dispatched proposal). Clamped
 *  to the final reply so the loop always terminates. */
export function demoScriptIndex(
	messages: readonly AiChatMessage[],
	script: readonly string[] = DEMO_AGENT_SCRIPT,
): number {
	const toolReplies = messages.filter((m) => m.role === MessageRole.Tool).length;
	return Math.min(toolReplies, script.length - 1);
}

/** The next scripted reply for the given transcript. Pure + total. */
export function nextDemoReply(
	messages: readonly AiChatMessage[],
	script: readonly string[] = DEMO_AGENT_SCRIPT,
): string {
	const reply = script[demoScriptIndex(messages, script)];
	// The index is clamped in-bounds, but satisfy `noUncheckedIndexedAccess`.
	return reply ?? script[script.length - 1] ?? "";
}

/** The scripted demo provider. Registered as the default ONLY when
 *  `BRAINSTORM_DEMO_AGENT` is set (see the provider registration in `index.ts`),
 *  so a demo-vault agent turn with no pinned provider routes here. `mode` is
 *  the env value — `"appforge"` selects the code-file script. */
export function createDemoAgentProvider(mode?: string): ModelProvider {
	const script = demoScriptForMode(mode);
	return {
		id: DEMO_AGENT_PROVIDER_ID,
		async generate(req: AiGenerateRequest): Promise<AiGenerateResult> {
			const usage = buildUsage(0, 0);
			return {
				content: nextDemoReply(req.messages, script),
				provider: DEMO_AGENT_PROVIDER_ID,
				model: "demo-agent",
				finishReason: "stop",
				...(usage ? { usage } : {}),
			};
		},
	};
}

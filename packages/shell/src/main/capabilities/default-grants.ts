/**
 * Default-minimum capability grants per §Capabilities:
 *
 *   Decision: capabilities are granted by the user, never inferred. There is
 *   no "implicit" capability beyond a default minimum: `storage.kv`
 *   (own keyspace), `intents.dispatch:open`, and the right to render UI in
 *   the app's own window.
 *
 * Plus, per §SDK surface:
 *
 *   Apps receive `credentials.read:self` and `credentials.write:self` as part
 *   of default-minimum capabilities. Cross-app credential access is not
 *   allowed — every app has its own isolated keyspace under Tier 2.
 *
 * `entities.write` for an app's own entity types is also default-minimum
 * because an app obviously needs to write what it owns; cross-type writes
 * require explicit grants.
 *
 * The shell itself (`app === "shell"`) gets a wider default set since it's
 * fully trusted.
 */

import { type CapabilityLedger, GrantedVia } from "./ledger";

export const SHELL_IDENTITY = "shell" as const;

/** Per-app capabilities granted automatically at install time. */
export const DEFAULT_APP_CAPABILITIES: ReadonlyArray<{ capability: string; scope?: string }> = [
	{ capability: "storage.kv" },
	{ capability: "intents.dispatch", scope: "open" },
	{ capability: "credentials.read", scope: "self" },
	{ capability: "credentials.write", scope: "self" },
	// Vault-level property + dictionary catalog (VP-3). Read access is
	// near-universal — every typed-rendering surface (cells, blocks, grids,
	// inspectors) needs the schema. Write access is granted by default in v1
	// because every first-party app (Notes constructor, Database column-create,
	// Graph property edit) writes through the same shared catalog; Stage 14
	// can tighten this for third-party apps when the monetisation surface
	// requires it.
	{ capability: "properties.read" },
	{ capability: "properties.write" },
	// Vault-wide lexical search. Read access is universal — apps that show
	// any list of entities need to surface "find" UX without paying a prompt.
	// Writes (re-indexing) only happen in-shell; there is no public write
	// capability for the search index.
	{ capability: "search.read" },
	// Member roster + display profiles (Collab-C6). Read access is near-universal:
	// any surface that shows collaborators (chat member list, comment @-mentions,
	// future presence) needs to resolve an entity's membership pubkeys to names.
	// It exposes only membership of entities the app can already read + the
	// self-asserted public display name, never vault content — so it's a benign
	// default, mirroring `properties.read` / `search.read`. The far-more-sensitive
	// WRITE side (`roster.write`, editing the signed identity profile) stays scarce
	// and is declared per-app (chat) or driven from the privileged Settings surface.
	{ capability: "roster.read" },
	// Read the share/access surface (Collab-C5): mint your OWN invite (public
	// keys only) + read the access record of entities the app can already read.
	// Benign like `roster.read` — the privileged GRANT side (`sharing.share`,
	// adding another person to an entity) stays scarce + shell-driven.
	{ capability: "sharing.read" },
	// Vault-shared cover-image library (B7.2). Mirrors `properties.write`'s
	// rationale: covers are a per-object universal property and every
	// first-party app that hosts the shared `<CoverPicker>` (Notes,
	// Database, Files, Bookmarks, Tasks, Journal) writes through the same
	// content-addressed, size-capped, ext-allow-listed store. Stage 14 can
	// tighten this for third-party apps alongside the properties tightening.
	{ capability: "covers.read" },
	{ capability: "covers.write" },
	// User-uploaded image icons ("custom emoji", B11.14). Same rationale as
	// covers: a vault-shared, content-addressed, size-capped, ext-allow-listed
	// image store that every first-party app's icon picker reads + writes
	// through. Stage 14 can tighten for third-party apps alongside covers.
	{ capability: "icons.read" },
	{ capability: "icons.write" },
	// Block-id → providing-app registry (9.11), read-only. Near-universal
	// like `search.read`: any app that renders a `BlockEmbedNode` must
	// resolve which app provides a block. The host owns registration
	// (manifest → installer); there is no app-facing write capability.
	{ capability: "blocks.read" },
	// Pin-any-object-to-dashboard (7.13). Default-minimum on the same
	// rationale as `covers.write` / `properties.write`: every first-party
	// app exposes "Pin to dashboard" on its objects through the one shared
	// object menu (`@brainstorm-os/sdk/object-menu`), and a pin is a thin,
	// reversible dashboard-state write that never touches the object. The
	// `IconRecord` stores only the entity id (no cross-app data leak); the
	// grant is unscoped — apps pin their own objects by id. Stage 14 can
	// tighten this for third-party apps alongside the properties/covers
	// tightening.
	{ capability: "dashboard.pin" },
	// Render-own-content-to-PDF (B11.12). Default-minimum: exporting the
	// content you already authored is benign, and the shell renders the
	// app-supplied HTML in a sandboxed, script-disabled, network-blocked
	// offscreen window (no Node/Electron reach, no egress) — so the privileged
	// surface is contained regardless of which app calls it. Every first-party
	// app that exports a document (Notes, Journal, Database, …) wants this.
	{ capability: "export.print-to-pdf" },
	// Runtime-registered shortcuts (6.10c) — register / unregister
	// state-dependent dynamic shortcuts + report the current active scope
	// for cheatsheet filtering. Default-minimum per §Capabilities:
	// "it's part of being an app". Apps register dynamic shortcuts that
	// publish to the shell-side `ShortcutRegistry` and survive only for the
	// app's lifetime (cleared on the app's last window close). The far more
	// dangerous `shortcuts.global` (system-wide hotkey hijack) stays out of
	// the default set and gates on explicit user grant (v2).
	{ capability: "shortcuts.register" },
	// Publish-own-selection (DND-1,). Default-minimum on the
	// same "part of being an app" rationale as `dashboard.pin` /
	// `shortcuts.register`: an app telling the shell "here is what I have
	// selected" is its own state, low-risk and reference-only (ids + labels,
	// never content). Default-grant lets apps adopt `useSelection` without a
	// manifest bump (the ratchet). The far-more-sensitive READ side
	// (`selection.read`, cross-app) stays scarce + shell-only below.
	{ capability: "selection.publish" },
	// Cross-app drag participation (DND-2,). Both default-
	// minimum on the "part of being an app" rationale: `dnd.drag` starts a drag
	// of your OWN selection (reference-only, like `selection.publish`); `dnd.drop`
	// lets you RECEIVE a drop over your own window. Neither is the real
	// authorization — the actual mutation a drop triggers (add-member, set-
	// property, …) is re-checked against the target's own operation cap
	// (`entities.write:<type>` etc.) fail-closed at perform time, and a hover
	// leaks only kinds+point (OQ-DND-2). Stage 14 can tighten for third-party.
	{ capability: "dnd.drag" },
	{ capability: "dnd.drop" },
	// `dnd.exportFile` drags a file OUT to the OS (scope D) — the user exporting
	// their OWN file (bytes the app already holds) to their OWN desktop, written
	// to a temp path the OS drag reads. Default-minimum like the rest of `dnd.*`.
	{ capability: "dnd.export-file" },
] as const;

/** The shell's own capability set — broad, mirrors what the dashboard renderer needs. */
export const SHELL_CAPABILITIES: ReadonlyArray<{ capability: string; scope?: string }> = [
	// Shell can do anything the broker checks for.
	{ capability: "storage.kv" },
	{ capability: "storage.docs" },
	{ capability: "entities.read", scope: "*" },
	{ capability: "entities.write", scope: "*" },
	{ capability: "credentials.read", scope: "*" },
	{ capability: "credentials.write", scope: "*" },
	{ capability: "intents.dispatch", scope: "*" },
	{ capability: "intents.handle", scope: "*" },
	{ capability: "properties.read" },
	{ capability: "properties.write" },
	{ capability: "search.read" },
	{ capability: "roster.read" },
	{ capability: "roster.write" },
	// Collab-C5 — the shell's privileged share surface (share dialog) grants /
	// revokes access under the user's authority; sandboxed apps don't get
	// `sharing.share` by default.
	{ capability: "sharing.read" },
	{ capability: "sharing.share" },
	{ capability: "covers.read" },
	{ capability: "covers.write" },
	{ capability: "blocks.read" },
	{ capability: "dashboard.pin" },
	{ capability: "files.pick" },
	// 9.10 — Files host service. The shell is fully trusted and may exercise
	// the open/save pickers + read/write on user-chosen paths (Settings →
	// Files revoke panel, future shell-side import flows). Apps must
	// declare these in their manifest and the user approves at install —
	// **NOT** in `DEFAULT_APP_CAPABILITIES`.
	{ capability: "files.read" },
	{ capability: "files.write" },
	// OS handoff (`shell.openExternal` / `shell.openPath`) — the
	// open-resolution ladder's rung 5 (doc 57 §System default). A
	// **scarce** capability, deliberately *not* in `DEFAULT_APP_CAPABILITIES`:
	// a user click in shell / first-party chrome exercises it implicitly
	// (the first-use consent prompt *is* the review), but an app or agent
	// must hold `system.open-external` explicitly to fling a URL/file at
	// the OS — making an HTTP request and "make the user's OS open this"
	// are different risks (same reasoning as `web.browse`). The Agent
	// app's three-tier fail-closed intersection bounds it further.
	{ capability: "system.open-external" },
	{ capability: "identity.sign" },
	{ capability: "ai.use" },
	{ capability: "ai.context", scope: "*" },
	{ capability: "ydoc.raw" },
	// 14.1 — read the account plan + entitlement cache. Scarce (NOT in
	// `DEFAULT_APP_CAPABILITIES`): the in-product Settings → Billing surface
	// (14.6) is shell-rendered, and an app that gates a feature on the plan
	// must hold this explicitly. The `billing` service re-checks it server-side.
	{ capability: "billing.read" },
	// DND-1 — read the focused app's published selection.
	// Scarce (NOT default-minimum): reading another app's selection crosses the
	// app boundary, so only the shell's privileged consumers (action surface,
	// keyboard "move to…", the future drag-session begin) hold it. The
	// `selection` service re-checks it server-side + validates against live focus.
	{ capability: "selection.read" },
] as const;

/**
 * Apply the default app caps for an app at install time. Idempotent.
 * Returns the grants created (or already present).
 */
export function applyDefaultAppGrants(
	ledger: CapabilityLedger,
	appId: string,
	grantedVia: GrantedVia = GrantedVia.Install,
) {
	return DEFAULT_APP_CAPABILITIES.map((c) =>
		ledger.grant({
			appId,
			capability: c.capability,
			scope: c.scope ?? null,
			grantedVia,
		}),
	);
}

/**
 * Apply the shell's own grant set. Called once on each shell startup so the
 * shell can talk to the broker like any other identity. Idempotent.
 */
export function applyShellGrants(ledger: CapabilityLedger) {
	return SHELL_CAPABILITIES.map((c) =>
		ledger.grant({
			appId: SHELL_IDENTITY,
			capability: c.capability,
			scope: c.scope ?? null,
			grantedVia: GrantedVia.Install,
		}),
	);
}

/**
 * Settings section enum. Separated from settings.tsx so Vite Fast Refresh
 * stays happy (a module that exports a non-component value next to a React
 * component disables HMR for that file).
 */

export enum SettingsSection {
	/** Combined Theme + Wallpaper section (doc 36 §Appearance modes & pair
	 *  slots): mode segmented control + two pair cards. Supersedes the
	 *  prior separate Wallpaper / Themes entries. */
	Appearance = "appearance",
	/** Uploaded-cover library manager (B7.2). Covers are a per-object
	 *  property; this section only prunes the shared content store. */
	Covers = "covers",
	General = "general",
	/** Interface (Track D): dashboard-header control visibility + clock
	 *  options. Reads/writes the per-vault `chrome` map. */
	Interface = "interface",
	/** Language & Region (Tracks A + B): UI-language picker (runtime switch)
	 *  + regional format overrides (hour cycle / first-day / number /
	 *  timezone). Writes the `locale` + `regional` maps. */
	LanguageRegion = "language-region",
	/** Notifications (Track C): OS-native toggle, do-not-disturb window,
	 *  per-app mutes, clear history. Writes the `notifications` map. */
	Notifications = "notifications",
	Security = "security",
	/** Vault-level properties catalog (dictionaries are managed inline
	 *  inside the property constructor for Select / Multi-select kinds). */
	Data = "data",
	/** Backup & Migration (IE-3): export the vault to a `.bsbundle`, import a
	 *  JSON/JSONL data file onto a vault type. */
	BackupMigration = "backup-migration",
	/** Global lexical-search index health + maintenance (Stage 9.22.4). */
	Search = "search",
	/** Per-object-type default opener app (doc 37 §Default handlers). */
	Defaults = "defaults",
	/** The action surface (doc 63 / AS-4): per-app toggle to disable an app's
	 *  contributed cross-app actions wholesale (Settings → Apps & contributions). */
	Contributions = "contributions",
	/** Keyboard shortcuts reference — read-only listing of shell-layer
	 *  action ids + their default chords, per the Help-vs-Settings split
	 *  in. Rebinding lands later
	 *  (gated on the per-renderer registry push). */
	Keyboard = "keyboard",
	/** AI (11.9) — BYO cloud provider API keys (Tier-2 credentials, 11.6).
	 *  Provider routing + per-app budgets land here as the broker grows. */
	Ai = "ai",
	/** Collab-C6 — your self-asserted display identity: the `Profile/v1`
	 *  display name + avatar collaborators see, plus the sovereign fingerprint.
	 *  Signed in main; edited through the privileged `profile.*` IPC. */
	Identity = "identity",
	/** Stage 10.5b — paired-device list, add-device flow, join-vault flow.
	 *  Surfaces the `pairing.*` privileged IPC introduced by 10.5a; the
	 *  broker-side wire-up lands at 10.5c. */
	Devices = "devices",
	/** Stage 10.7 — live sync status (state / relay / traffic / dropped /
	 *  seq diagnostic). Drill-down for the dashboard chip; same data,
	 *  expanded. */
	Sync = "sync",
	/** Plan + billing surface — visual-only pricing tiers, billing-cycle
	 *  toggle, current-plan state, mocked checkout. Real Stripe / seat
	 *  management arrive in v2 (see project_marketplace_mvp memory). */
	Membership = "membership",
	/** 14.6 — the real account/billing state: current plan + entitlement,
	 *  account link (billing-edge refresh credential), invoices, and
	 *  portal / Stripe-Checkout deep links (payment never renders
	 *  in-product). Membership above stays the pricing/compare surface. */
	Billing = "billing",
	/** Net-1f — Privacy → Network egress UI. Active proxy, privacy mode
	 *  (link previews + embeds), per-app egress audit (with revoke),
	 *  recent + blocked requests over the rotated audit log, preview-
	 *  cache stats. Privileged-only (the IPC channels are dashboard-
	 *  bound). */
	Network = "network",
	/** 9.8.8 — Recently Deleted: the Bin's Settings face. Retention-window
	 *  preference + a live count + the jump into the Bin overlay (restore /
	 *  permanent delete stay there — one surface owns the list). */
	RecentlyDeleted = "recently-deleted",
}

# Roadmap

Brainstorm is a local-first desktop OS for knowledge management. Your data lives in a plain folder on your machine, there is no account, and the apps are sandboxed with explicit permissions.

This page is what is coming. Most of it is the **What's coming** section below — per app, in detail. There is also an honest account of what is shipped, what is mid-flight, and what we will never build, so you can tell the difference.

**No dates.** We ship when something is ready. Order reflects intent, not commitment.

Current release: **0.13.0**. See [releases](https://github.com/brainstorm-os/shell/releases) and the [changelog](https://getbrainstorm.online/blog).

---

## Shipped

Things you can use today.

- **Twenty apps** — Notes, Tasks, Database, Calendar, Files, Graph, Whiteboard, Journal, Books, Bookmarks, Contacts, Chat, Browser, Mailbox, Code editor, Preview, Automations, Agent, Theme editor, Forms. All on the same SDK and the same permission system.
- **Local-first storage** — your vault is a folder you control. No account, no sign-up, no server required to use the product.
- **End-to-end encrypted sync** through a blind relay that cannot read your content.
- **Sharing** — share an object or a collection with someone by name, with per-object permissions and immediate revocation.
- **Agents as vault members** — an agent has a name, holds permissions from the same list a person holds, proposes changes you approve, and has an activity log covering every run, tool call and refusal.
- **Apps that call each other** — an app can publish typed actions other apps discover, appearing in object menus, the editor, automations, and to your agent. You approve the first call, and again if the app changes what the action does.
- **Build an app inside Brainstorm** — an app is a manifest and an entry page. Write one in the code editor and install it into your own vault, or ask the agent to draft it.
- **Signed and notarized builds** for macOS, Windows and Linux, with in-app updates.

## In progress

Being actively worked on. Listed because it is honest, not because it is promised.

- **Multi-device sync for your own devices.** The receiving half shipped some time ago; the half that hands your second device its keys is landing now. **It is not yet verified between two real machines**, so do not rely on it until this line moves to Shipped.
- **Peer-to-peer sync over a local network** — two machines on the same Wi-Fi syncing with no server in the middle. Pairing and discovery work; the data does not converge over that link yet.
- **A marketplace** — the storefront, the signed catalog, install and update engines all exist in the product. Nothing is hosted yet, so there is nothing to browse. That is the remaining work.

## What's coming

The detail, by area. Order is roughly our intent; nothing here has a date.

### Graph

Today the graph draws itself one way — a force-directed cloud. That is a good default and a poor answer to most specific questions, so the next work is **layouts you choose per graph**:

- **Hierarchical / layered** — dependencies top to bottom. Force-directed hides direction; this makes it the point. The one we most want.
- **Radial / ego** — pick a node, see its world in rings by distance.
- **Timeline** — position by when things were created, so the graph shows how your knowledge actually grew.
- **Clustered** — automatic community grouping with collapsible super-nodes, which is also how very large graphs stay readable.
- **Layout remembered per graph**, alongside saved filters.

### Database

The engine underneath is already strong — formulas, rollups, aggregations, typed filters, relations. What is missing is ways to *look* at it:

- **Charts** — bar, line and pie over any grouping. The aggregation engine already computes these numbers; they just have nowhere to be drawn.
- **Calendar view** — any list with a date column becomes a calendar.
- **Gallery view** — cards with covers, for anything visual.
- **Timeline / Gantt** — two date columns become a span, with relations as dependencies.
- **Saved views** — name a filter + sort + layout and switch between them.

### Notes and the editor

- **Embed blocks** — YouTube and maps first, click-to-load so nothing calls out until you ask.
- **Deeper backlinks** — see what references a note, in context, not just a list.
- **Document outline** for long notes.

### Tasks, Calendar, Files

- **Recurring tasks** and **task dependencies**, with a workload view.
- **Scheduling and availability** in Calendar, now that CalDAV sync is in.
- **Broader file previews** and **bulk operations** in Files.

### Whiteboard, Books, Bookmarks

- **Whiteboard templates** and smarter connector routing.
- **Annotations and highlights** that persist across Books and captured Bookmarks, and reading position that follows you.

### Agent and automations

- **Agents that hand work to each other** with the narrowest permissions of both — the groundwork shipped in 0.13.0.
- **Richer automation triggers**, and agents you can put on a schedule.

### Platform

- **A marketplace you can browse** — install and update apps, including third-party ones. The product side is built; hosting it is the remaining work.
- **Publishing for anyone** — a developer portal, review queue and threat-intel feed, so it is not just our apps.
- **Peer-to-peer sync on a local network** — two machines on the same Wi-Fi, no server in the middle.
- **A mobile companion** — read, capture and light editing against the same vault.
- **More themes and deeper theming**, building on the theme editor.

## Not planned

Being explicit, because these come up.

- **A web version.** The product is a desktop shell that runs sandboxed apps against local files. That is the point.
- **An account system.** There is nothing to sign in to, and we are not adding one.
- **Selling your data, ads, or tracking inside the app.** The website counts page views without cookies or identifiers; the app does not phone home about your content.

---

## Known gaps

Not roadmap items — things that are wrong today and that we think you should know.

- **Journal entries damaged before 0.13.0 cannot be recovered.** A bug dropped the first words typed into a brand-new day, and once that happened the day's body stayed blank. The bug is fixed and the product can now tell you which documents are affected, but the lost text was never written to disk and cannot be restored.
- **Windows builds are unsigned**, so SmartScreen will warn you. macOS builds are signed and notarized.
- **It is a beta.** Keep backups of anything important. Your vault is a plain folder, so backing it up is a copy.

---

## Contributing to this roadmap

Open an [issue](https://github.com/brainstorm-os/shell/issues) or a [discussion](https://github.com/brainstorm-os/shell/discussions). We read them. If something here is wrong or out of date, that is a bug in this file and worth reporting like any other.

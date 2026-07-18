<p align="center">
  <a href="https://getbrainstorm.online"><img src="https://getbrainstorm.online/favicon.svg?v=indigo" width="72" alt="Brainstorm logo"></a>
</p>

<h1 align="center">Brainstorm</h1>

<p align="center"><strong>A desktop OS for you and your AI.</strong></p>

<p align="center">
  Brainstorm runs your apps, your data, and your AI on your own machine.<br>
  Install what you need, keep every file on your disk, and let AI help — only with the parts you hand it.
</p>

<p align="center">
  <a href="https://github.com/brainstorm-os/shell/releases/latest"><img src="https://img.shields.io/github/v/release/brainstorm-os/shell?label=beta&color=5b62e0" alt="Latest release"></a>
  <a href="https://github.com/brainstorm-os/shell/releases"><img src="https://img.shields.io/github/downloads/brainstorm-os/shell/total?color=5b62e0" alt="Total downloads"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/github/license/brainstorm-os/shell" alt="License: AGPL-3.0-or-later"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-555" alt="Platforms: macOS, Windows, Linux">
  <a href="https://deepwiki.com/brainstorm-os/shell"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

<p align="center">
  <a href="https://getbrainstorm.online/downloads"><strong>Download</strong></a> ·
  <a href="https://getbrainstorm.online">Website</a> ·
  <a href="https://getbrainstorm.online/apps">The apps</a> ·
  <a href="https://docs.getbrainstorm.online">Docs</a> ·
  <a href="https://github.com/brainstorm-os/shell/releases">Releases</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://getbrainstorm.online/screenshots/midnight/desktop.webp?v=indigo">
  <img src="https://getbrainstorm.online/screenshots/desktop.webp?v=indigo" alt="The Brainstorm desktop — wallpaper, app icons, widgets, and open app windows" width="100%">
</picture>

Your screen becomes a real desktop: a wallpaper, app icons, windows. Each icon is its own sandboxed app — Notes, Database, Graph, Calendar, Mailbox, twenty in all — and every app works from **one set of objects living in a folder on your disk**. A note you write here is a row there and a node in the graph. Never a copy, never an export.

## Download

**[Get the public beta →](https://getbrainstorm.online/downloads)** — free, no account, your data stays on your machine.

| Platform | Requirement | Builds |
| --- | --- | --- |
| **macOS** | macOS 12 Monterey or later | `.dmg` for Apple silicon and Intel — signed and notarized |
| **Windows** | Windows 10 or later | Installer `.exe` |
| **Linux** | x86_64 or arm64 | AppImage · `.deb` |

Every build is also on [GitHub Releases](https://github.com/brainstorm-os/shell/releases/latest), and installs update in-app from **Settings → Updates**. Windows builds are currently unsigned, so SmartScreen will ask — choose **More info → Run anyway**. It's a beta: keep backups of anything you'd mind losing.

## Why it's different

Plenty of tools do local-first notes. Brainstorm is built around a different question: **when you let AI into your knowledge, who decides what it can touch?**

- **A capability ledger between everything.** Apps and AI get no ambient access. Every request crosses a broker that checks a per-vault ledger of grants — each one specific, logged, and revocable. If the system can't verify a request, it fails closed: the answer is no.
- **Your models, your keys.** The shell's AI broker is the single path for every AI call. Point it at a local model via Ollama, or bring your own key for Anthropic, OpenAI, Gemini, or GLM. Keys are sealed in the OS keychain on the shell side; apps never see them.
- **Provenance and budgets.** AI activity leaves a record on the objects it touched, and every app runs under a spend budget you set.
- **Local-first, honestly.** Your vault is a folder of CRDT documents on your disk. Sync is optional and end-to-end encrypted — the relay only ever sees scrambled bytes. No account, no server dependency.

Agents as teammates — AI with its own identity, its own permissions, and a history of what it did — is where this is heading. That part is [on the roadmap](https://getbrainstorm.online/#roadmap), not dressed up as already shipped. What ships today is the groundwork that makes it governable: the broker, the ledger, provenance, budgets.

## Twenty apps, one vault

Notes · Database · Tasks · Calendar · Journal · Files · Graph · Whiteboard · Mailbox · Chat · Contacts · Bookmarks · Books · Web Browser · Code Editor · Preview · Form Designer · Automations · Theme Editor · Agent

Each app runs sandboxed in its own window, declares the capabilities it needs, and can be added, removed, or updated independently of the shell and of each other. Because they all read and write the same typed object space, apps are views, not silos: the Calendar projects every object that carries a date, the Graph draws every object and link, the Database opens anything as a grid, board, calendar, or timeline.

<table>
  <tr>
    <td width="33%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://getbrainstorm.online/screenshots/midnight/agent.webp?v=indigo">
        <img src="https://getbrainstorm.online/screenshots/agent.webp?v=indigo" alt="Agent — chat over the AI broker with cited vault objects">
      </picture>
    </td>
    <td width="33%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://getbrainstorm.online/screenshots/midnight/database.webp?v=indigo">
        <img src="https://getbrainstorm.online/screenshots/database.webp?v=indigo" alt="Database — the whole vault as grid, board, calendar, or timeline">
      </picture>
    </td>
    <td width="33%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://getbrainstorm.online/screenshots/midnight/graph.webp?v=indigo">
        <img src="https://getbrainstorm.online/screenshots/graph.webp?v=indigo" alt="Graph — every object and typed link on a live WebGL canvas">
      </picture>
    </td>
  </tr>
</table>

**[Every app, fully described — capabilities and screenshots →](https://getbrainstorm.online/apps)**

## How it's built

Three layers, two boundaries:

- **Apps** are sandboxed renderers. Cross-app isolation is the security boundary — an app sees nothing it wasn't granted.
- **The shell** (Electron main process plus a privileged dashboard renderer) owns the window manager, the app registry, the capability ledger, and the IPC broker. Every host-service call is a structured, identity-stamped envelope; the broker verifies the caller, checks the grant, and forwards. Any failure in that chain returns *unavailable* — never approval.
- **Core services** run as isolated worker processes: storage (SQLite), documents (Yjs), search.

Three external technologies anchor the system:

- **[Block Protocol](https://blockprotocol.org/)** — the interop layer for data and embeddable UI. Apps publish and consume blocks against typed entities so they can share information without sharing code.
- **[Yjs](https://yjs.dev/)** — the CRDT runtime for local-first data and sync. Documents are Yjs docs; offline merging, awareness, and presence come from the same primitive.
- **[Lexical](https://lexical.dev/)** — the editor framework powering rich text wherever it appears.

## Building from source

Requires [Bun](https://bun.sh).

```sh
bun install        # install workspace deps
bun run dev        # launch the shell in dev mode (hot reload)
```

Other scripts: `bun run build`, `bun run test`, `bun run typecheck`, `bun run lint`.

The repo is a Bun-workspaces monorepo: `packages/shell` is the Electron shell (main, preload, dashboard renderer, workers); `packages/{tokens,sdk,sdk-types,react-yjs,editor,cli}` are the libraries apps build on; `apps/` holds the twenty first-party apps, each an independently built sandboxed bundle. Design docs and the implementation plan are maintained privately in the project's `harness` repository.

## Why this exists

Brainstorm is a deliberate second attempt. A previous effort in this space became hard to evolve because everything was interconnected — data, UI, sync, schema, and product surface fused into a single mass. You can't bolt a permission system onto a monolith after the fact: adding AI to something like that means giving it everything or nothing.

So the retry's central organizing principle is **separation**. The shell hosts apps; apps interoperate only through standard contracts — typed entities, capability grants, host services; the schema is owned by no one app; and anything that wants your data (an app, a sync relay, a model) has to ask for it specifically and can be refused. That structure is what makes "AI you can govern" possible at all.

## License

[AGPL-3.0-or-later](LICENSE.md) © Brainstorm — free and open source; network use triggers the copyleft source-disclosure obligation.

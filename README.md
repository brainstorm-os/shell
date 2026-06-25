# Brainstorm

A knowledge-management product modeled as a desktop OS — local-first, on your machine. **[getbrainstorm.online](https://getbrainstorm.online)**

The shell is a dashboard with a wallpaper, icons, and widgets. The work happens in **apps** — a text editor, a database, a file viewer, a PDF editor, a graph viewer, a code editor, and so on — each launched in its own window and responsible for its own logic. Apps can be added, removed, and updated independently of the shell and of each other.

Three external technologies anchor the system:

- **[Block Protocol](https://blockprotocol.org/)** — the interop layer for data and embeddable UI. Apps publish and consume blocks against typed entities so they can share information without sharing code.
- **[Lexical](https://lexical.dev/)** — the editor framework powering rich text wherever it appears (the text-editor app, inline rich text in other apps).
- **[Yjs](https://yjs.dev/)** — the CRDT runtime for collaboration and local-first sync. Documents are Yjs docs; awareness, presence, and offline merging come from the same primitive.

## Running

```sh
bun install        # or `npm install` / `pnpm install`
bun run dev        # launches the shell in dev mode (hot reload)
```

Other scripts: `bun run build`, `bun run typecheck`, `bun run lint`.

## Layout

```
app/
├── packages/
│   ├── shell/                  ← Electron shell (main + preload + dashboard renderer)
│   │   ├── art/                ← runtime icons
│   │   ├── src/{main,preload,renderer}
│   │   └── electron.vite.config.ts
│   ├── tokens/                 ← @brainstorm/tokens (semantic design tokens)
│   ├── sdk/                    ← @brainstorm/sdk
│   ├── sdk-types/              ← @brainstorm/sdk-types
│   ├── react-yjs/              ← @brainstorm/react-yjs
│   ├── editor/                 ← @brainstorm/editor
│   └── cli/                    ← @brainstorm/cli
├── apps/                       ← first-party sandboxed apps
├── tools/                      ← dev tooling (icon build, checks, …)
├── scripts/                    ← dev scripts
├── tsconfig.base.json          ← shared TypeScript config
├── tsconfig.json               ← workspace-wide check (typecheck everything)
├── vitest.config.ts            ← workspace-wide tests
├── biome.json                  ← lint + format
└── package.json                ← Bun workspaces root
```

We use **Bun workspaces** for the monorepo. The shell is one package; design tokens are a separate package; SDK/editor/CLI are libraries the apps build on.

## Why this exists

A previous attempt in this space became hard to evolve because everything was interconnected — data, UI, sync, schema, and product surface fused into a single mass. Brainstorm is a deliberate retry where the central organizing principle is **separation**: the shell hosts apps, apps interoperate only through standard contracts (Block Protocol entities, capability grants, host services), and the schema is owned by no one app.

Design docs, the implementation plan, and internal references are maintained privately in the project's `harness` repository.

## License

[FSL-1.1-Apache-2.0](LICENSE.md) © Brainstorm — source-available, converts to Apache-2.0 two years after each release.

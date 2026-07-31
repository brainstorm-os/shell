# Contributing to Brainstorm

Thanks for your interest in Brainstorm. The project is in public beta and moving fast, so this guide focuses on the contributions that help most right now and on getting you productive in the codebase quickly.

## Ways to contribute

- **Report a bug.** Use the [bug report template](https://github.com/brainstorm-os/shell/issues/new?template=bug_report.yml). Include your Brainstorm version (Settings → What's new) and platform. Please describe the behavior, not your data — never paste vault content into an issue.
- **Propose an idea.** Use the [idea template](https://github.com/brainstorm-os/shell/issues/new?template=idea.yml). Brainstorm has strong opinions (local-first, capability-gated, one vault of typed objects), so a short "why" goes further than a feature list.
- **Improve the code.** Bug fixes, accessibility improvements, localization, performance work, and test coverage are all welcome. For anything larger than a focused fix, **open an issue first** so we can agree on the approach before you invest time — the architecture has hard boundaries (see below) and a PR that crosses them can't be merged, however good the code is.
- **Report a security issue privately.** Please do not open a public issue for anything security-sensitive — use [GitHub's private vulnerability reporting](https://github.com/brainstorm-os/shell/security/advisories/new) or email [founder@getbrainstorm.online](mailto:founder@getbrainstorm.online). Details in the [security policy](SECURITY.md).

Participation in the project is covered by our [code of conduct](CODE_OF_CONDUCT.md).

## Getting set up

Requires [Bun](https://bun.sh) and a Rust toolchain (for the small native crates built via napi-rs).

```sh
git clone https://github.com/brainstorm-os/shell.git
cd shell
bun install
bun run dev        # builds the native crates, then launches the shell with hot reload
```

The everyday commands:

```sh
bun run test              # vitest suites (unit + integration)
bun run typecheck         # tsc across packages AND apps — both halves matter
bun run lint              # biome + the repo's custom lint ratchets
bun run format            # biome format --write
bun run verify            # the pre-PR gate: native build + typecheck + lint + app builds + integration tests
```

Run `bun run verify` before opening a PR — it is the same gate CI applies.

### Repo layout

This is a Bun-workspaces monorepo:

- `packages/shell` — the Electron shell: main process, preload, dashboard renderer, and the worker processes (storage, documents, search).
- `packages/{sdk,sdk-types,tokens,react-yjs,editor,block-protocol,protocol,capabilities,…}` — the libraries apps and the shell build on.
- `packages/{native,native-embed,native-image}` — small Rust crates (napi-rs) for crypto, embeddings, and image work.
- `apps/` — the twenty first-party apps, each an independently built sandboxed bundle.
- `tools/` — dev tooling, including the custom lint checks that `bun run lint` runs.

Design docs and the implementation plan are maintained privately; the architecture summary in the [README](README.md#how-its-built) and the conventions below are the contributor-facing source of truth.

## Architecture ground rules

These are the boundaries PRs are reviewed against. They exist so that "AI you can govern" stays possible:

1. **Apps are sandboxed; the capability ledger is the law.** An app reaches host services only through the IPC broker, with a manifest-declared capability. Anything that can't be verified **fails closed** — returns unavailable, never approval. Never add a side channel around the broker.
2. **Crypto and secrets are centralized.** Only the credential store touches keychain/keystore APIs. Apps never see keys.
3. **No inline SQL outside repository classes.** Every table has a typed repo; feature code orchestrates repos.
4. **Local-first is non-negotiable.** No feature may require a network service to function. Sync is optional and end-to-end encrypted.

## Code conventions

The short version — CI enforces most of this, so knowing it up front saves a round trip:

- **TypeScript strict**, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Files and folders are `kebab-case`; components/types `PascalCase`; functions/variables `camelCase`.
- **Named exports only** for library code (no default exports).
- **Every user-visible string goes through `t()`** — no bare JSX text. Shell strings live in the FormatJS/ICU catalog; app strings use the SDK's lighter `createT` (interpolation only, plurals via the shared `plural()` helper).
- **Reuse the SDK before writing a component.** Menus go through the shared menu runtime, dialogs through the shared `<Popover>`, selects through `<SelectMenu>` — never a bespoke `<div>` menu or a native `<select>`. Custom lint checks reject these.
- **Keyboard handling goes through the shortcut registry** (`useShortcut`), never raw `e.key` handlers.
- **No magic string discriminators** — use enums or `as const` unions.
- **CSS references only real design tokens.** A `var(--made-up-name)` fails lint.
- **Comments explain *why*, never *what*.**
- **New features ship with tests.** Fix a bug by first writing the failing test, then the patch.

## Pull requests

- **Branch from `main`**, one concern per PR. Small, reviewable PRs merge fast; grab-bag PRs stall.
- **Conventional Commits** for commit messages and the PR title: `feat(scope): …`, `fix(scope): …`, `docs: …`, `chore: …`. The scope is usually the package or app (`shell`, `sdk`, `notes`, `sync`, …).
- **Say what and why** in the PR body, and link the issue it addresses. For UI changes include a screenshot, and note the keyboard path for the new surface.
- **Green `bun run verify` locally** before pushing. CI additionally runs the full test suite on Linux, so run `bun run test` too if you touched shared code.
- Anything that adds a **capability, IPC method, or dependency** gets a security-focused review — call it out explicitly in the PR description so review starts in the right place.

Expect review feedback to be direct and standards-driven; it's about the code, never about you.

## License

Brainstorm is [AGPL-3.0-or-later](LICENSE.md). By contributing, you agree that your contributions are licensed under the same terms.

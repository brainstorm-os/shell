# `@brainstorm-os/native`

Native NAPI-RS bindings for the Brainstorm shell. Foundation for the post-beta `NAPI-1..4` performance track:

| Iter | Replaces | Win |
| ---- | -------- | --- |
| **NAPI-1** (this package) | — | toolchain + smoke export |
| **NAPI-2** | `@noble/hashes/argon2.js` (in `main/credentials/keystore-passphrase.ts`) | vault-unlock ~3 s → ≤500 ms |
| **NAPI-3** | `@noble/{hashes,ciphers,curves}` (across `credentials/*`, `sync/envelope-seal.ts`, `pairing/sas.ts`) | one audited crypto boundary |
| **NAPI-4** | `apps/graph/src/render/force-layout.ts` | 600-node cap lifted; 3–5× headroom |

## Status

**NAPI-1 foundation only.** The only export is `smokeSum(a, b)` and exists to prove the Rust ⇆ Node ABI is wired end-to-end. No real consumers in the shell yet — those land with NAPI-2..4.

## Build

```sh
# host triple (release)
bun run --filter @brainstorm-os/native build

# host triple (debug — faster compile, big binary, used by tests)
bun run --filter @brainstorm-os/native build:debug
```

Produces `brainstorm-native.<platform>-<arch>.node` + an auto-generated `index.js` + `index.d.ts` at the package root. All three are gitignored; consumers run `build` before importing.

## Test

```sh
bun run --filter @brainstorm-os/native test
```

Builds debug + runs the smoke vitest at `test/smoke.test.ts`. The test is package-local on purpose — the root `bun run test` does **not** invoke it (the `.node` binary isn't part of the workspace include glob) so a fresh `bun install` doesn't fail before the first build.

## Adding a function

1. Add `#[napi] pub fn my_thing(...) -> ...` to `src/lib.rs`. Use `napi_derive` types — `String`, `Vec<u8>`, `Option<T>`, simple primitives all marshal cleanly.
2. `bun run --filter @brainstorm-os/native build` to regenerate `index.js` + `index.d.ts`.
3. Import from `@brainstorm-os/native` in the consumer (shell main, app worker, etc.). The package is a Bun workspace member, so the name resolves without extra config.
4. Add a unit test under `test/` mirroring `smoke.test.ts`.

## Distribution

Prebuilt binaries ship through `electron-builder`'s artifact step at `13.1` — they are never published to npm, so the `files` field is informational only.

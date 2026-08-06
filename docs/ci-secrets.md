# CI secrets — what they are and how to obtain each one

The GitHub Actions workflows referenced ten secrets. GitHub secrets are
**write-only**: they cannot be read back, and the `th3-br41n` account is
suspended anyway. Every value below has to come from its original source, not
from GitHub.

Add each one at
**https://gitlab.com/brainstorm-os/shell/-/settings/ci_cd → Variables → Add variable**
with **Mask variable** on and **Protect variable** on (so it is only exposed on
protected branches and tags). Masking requires the value to be a single line,
at least 8 characters, and base64-ish — the certificate blobs qualify; if GitLab
refuses to mask one, use **File** type instead of **Variable** and adjust the job
to point at the file path.

## Priority — read this first

**Only one of these has a job that can use it today.** `release.yml` was
deliberately not ported to GitLab: it needs macOS and Windows runners plus
signing, and releases currently go out from a workstation via
`tools/publish-gitlab-release.sh`. So eight of the ten are *preparation* for a
future release pipeline, not something that unblocks anything now.

| secret | needed for | urgency |
|---|---|---|
| `CATALOG_PUBLISHER_SEED` | publish-catalog | **the only one with a portable job** |
| `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` | release (macOS signing) | only if release moves to CI |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | release (notarisation) | only if release moves to CI |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | release (Windows signing) | only if release moves to CI |
| `BRAINSTORM_FEEDBACK_ENDPOINT` | release | optional — unset is a supported state |
| `GITHUB_TOKEN` | — | **does not transfer, see below** |

---

## 1. `CATALOG_PUBLISHER_SEED`

**What it is.** A 32-byte Ed25519 seed, as **64 hex characters**. It signs the
first-party app catalog. `tools/publish-first-party-catalog.ts` validates it
against `/^[0-9a-fA-F]{64}$/`.

**⚠️ The failure mode is silent.** If the variable is unset *or* malformed, the
publisher does not error — it falls back to a dev seed (32 bytes of `0x0b`) and
publishes a catalog signed by the wrong identity. A typo produces a successful
run and a bad artefact. Verify the published catalog's publisher key after the
first real run.

**How to get it.** If you still have the original seed (password manager, the
machine you generated it on), use that — the publisher identity stays stable.

If it is lost, generate a new one:

```sh
openssl rand -hex 32
```

Regenerating changes the publisher identity. Clients verify a bundle against the
`publisherKey` carried **in the catalog entry** (`bundle-acquire.ts` takes it as
a parameter; no pinned key was found in the client), so a new key should verify
fine for newly published catalogs. **Confirm that before relying on it** — if
anything trusts-on-first-use or caches the old key, already-installed apps could
fail verification.

## 2–3. macOS signing: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`

`release.yml` maps `MAC_CSC_LINK` → `CSC_LINK`, which electron-builder reads.

**What it is.** `MAC_CSC_LINK` is a **base64-encoded `.p12`** containing your
*Developer ID Application* certificate and its private key.
`MAC_CSC_KEY_PASSWORD` is the password set when exporting it.

**How to get it.**

1. Open **Keychain Access** on the Mac that has the certificate.
2. Find **Developer ID Application: \<your name\> (\<TEAM_ID\>)** under *My Certificates*.
   It must have a disclosure triangle — that means the private key is attached.
   Without the private key it cannot sign.
3. Right-click → **Export** → format *Personal Information Exchange (.p12)* →
   set a strong password (this becomes `MAC_CSC_KEY_PASSWORD`).
4. Encode it:

```sh
base64 -i DeveloperID.p12 | tr -d '\n' | pbcopy
```

If the certificate no longer exists, create a new one at
https://developer.apple.com/account/resources/certificates → **Developer ID
Application**. You need the Apple Developer Program ($99/yr) and Account Holder
or Admin rights.

## 4–6. Notarisation: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

- **`APPLE_ID`** — the email of your Apple Developer account.
- **`APPLE_APP_SPECIFIC_PASSWORD`** — *not* your Apple password. Generate at
  https://account.apple.com → **Sign-In and Security** → **App-Specific
  Passwords** → **+**. Format `xxxx-xxxx-xxxx-xxxx`. Shown **once** — copy it
  immediately. Revoking the old one is safe; it only affects notarisation.
- **`APPLE_TEAM_ID`** — the 10-character team ID at
  https://developer.apple.com/account → *Membership details*. It is also the
  parenthesised suffix of the certificate name in Keychain.

## 7–8. Windows signing: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`

Same shape as macOS: `WIN_CSC_LINK` is a **base64-encoded `.pfx`** code-signing
certificate, `WIN_CSC_KEY_PASSWORD` its password.

```sh
base64 -i codesign.pfx | tr -d '\n' | pbcopy
```

**Note:** modern OV/EV Windows certificates are often issued on a hardware token
or via a cloud signing service, in which case there is no exportable `.pfx` and
this approach does not apply — you would sign through the provider's tooling
instead. Check what your issuer gave you before assuming a file exists.

## 9. `BRAINSTORM_FEEDBACK_ENDPOINT`

The URL the packaged app posts feedback reports to, baked in at build time.

**Unset is a supported state**, and the workflow says so explicitly: with no
value the client keeps reports local, which is the pre-existing behaviour, not a
regression. Set it only if you want feedback reaching your collector, and use
the same URL the current builds point at so behaviour does not change between
releases.

## 10. `GITHUB_TOKEN` — does not transfer

GitHub injects this automatically; there is no value to copy and no GitLab
equivalent to create. GitLab's automatic `CI_JOB_TOKEN` is *not* a drop-in — it
cannot create releases the same way.

This does not need solving: `tools/publish-gitlab-release.sh` already uses a
personal access token with `api` scope, which is how releases reach GitLab now.
If release packaging later moves into CI, add that PAT as a masked, protected
variable (e.g. `GITLAB_RELEASE_TOKEN`) rather than trying to reproduce
`GITHUB_TOKEN`.

---

## After adding them

Nothing consumes these until the corresponding job exists. To exercise
`CATALOG_PUBLISHER_SEED`, port `publish-catalog.yml` — it is the easy one, since
it runs on Linux and needs no signing.

Do **not** paste any of these into a merge request description, a job log, or an
issue. Masked variables are redacted from job output only if masking was
accepted; confirm the variable shows as masked in the settings UI after saving.

# Security Policy

Brainstorm's core promise is that your data stays yours: apps are sandboxed, every privileged call crosses a capability broker that fails closed, sync is end-to-end encrypted, and keys live in the OS keychain. A hole in any of that is the most important bug we can hear about — thank you for taking the time to report it.

## Reporting a vulnerability

**Please do not open a public issue for anything security-sensitive.**

- **Preferred:** [Report privately via GitHub](https://github.com/brainstorm-os/shell/security/advisories/new) (Security tab → *Report a vulnerability*). This keeps the report, the discussion, and any fix coordinated in one private place.
- **Alternative:** email [founder@getbrainstorm.online](mailto:founder@getbrainstorm.online).

Include what you can: the Brainstorm version (Settings → What's new), platform, steps to reproduce, and your assessment of impact. A proof of concept helps enormously; please demonstrate it against your own vault and data only.

You can expect an acknowledgment within **72 hours** and an assessment within **a week**. Brainstorm is maintained by a very small team, so we ask for reasonable time to ship a fix before public disclosure — we'll agree on a timeline with you in the report thread, and we'll credit you in the release notes unless you'd rather stay anonymous. There is currently no bug bounty program.

## Scope

Reports of highest interest — the boundaries the product's security model stands on:

- **App-sandbox escape** — a sandboxed app reading or writing anything it wasn't granted, reaching Node/Electron APIs, or escaping its renderer.
- **Capability-broker bypass** — any path to a host service that skips or defeats the IPC broker, the identity stamping, or the per-vault capability ledger; anything that makes a denied request succeed.
- **Cross-app isolation failures** — one app observing or influencing another app's data or execution.
- **Cryptography flaws** — in vault encryption, end-to-end encrypted sync, device pairing, collection sharing / key rotation, or identity signatures.
- **Credential exposure** — API keys, sync keys, or keychain-held secrets reaching an app, a log, a crash report, or the network.
- **Update-mechanism attacks** — anything that could make the in-app updater install an unintended artifact.
- **AI-boundary failures** — model-directed actions escaping their granted capabilities or spend budgets, including via prompt injection from vault content.

Out of scope: issues requiring full control of the user's OS account or physical machine, denial of service against your own local instance, vulnerabilities purely in third-party dependencies with no Brainstorm-specific exploit path (report upstream — though a heads-up is welcome), and social engineering.

## Supported versions

Brainstorm is in public beta. Security fixes ship in new releases on the latest release line — always via [the current release](https://github.com/brainstorm-os/shell/releases/latest) and the in-app updater (**Settings → Updates**). Older builds are not patched retroactively.

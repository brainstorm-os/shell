/**
 * `@brainstorm-os/sdk/tooltip` — the one app-side tooltip layer. A delegated
 * controller (`mountTooltipHost`) renders the animated `.bs-tooltip` chip for
 * any element carrying `data-bs-tooltip`, replacing the slow, unstyled native
 * `title=` OS tooltip that app icon buttons used to rely on.
 *
 * `BrainstormMenuProvider` installs the controller automatically, so every
 * app that mounts the menu runtime gets tooltips for free — a raw `<button>`
 * just opts in with the attribute:
 *
 *   <button aria-label={t("…")} data-bs-tooltip={t("…")}>…</button>
 *
 * Import the styles once per renderer alongside the menu styles:
 *   import "@brainstorm-os/sdk/tooltip.css";
 */

export { mountTooltipHost } from "./host";

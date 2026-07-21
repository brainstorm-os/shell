/**
 * @brainstorm-os/cli — developer-side tooling for app + theme authors.
 *
 * v1 ships the theme `pack` command (9.9.6): validate a theme package against
 * the same token / contrast / StylePack-CSS validators the theme-editor uses,
 * then emit a normalized bundle. Scaffolding (create-app), bundle signing, and
 * publishing land in later stages per.
 */

export { PackComponent, PackSeverity, formatPackIssues, packTheme } from "./theme-pack";
export type { PackIssue, PackResult, ThemePackage } from "./theme-pack";
export { runCli } from "./cli";
export type { CliIo } from "./cli";

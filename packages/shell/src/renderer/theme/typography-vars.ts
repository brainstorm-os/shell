/**
 * Render-application of the frozen `brainstorm/Typography/v1` contract
 * (Stage 8.7). The implementation moved to `@brainstorm-os/sdk/typography`
 * at copy two (the theme-editor's typography editor, Stage 9.9.3, reuses
 * it for in-editor live preview); this file re-exports so the shell's
 * `ThemeProvider` + existing importers are unchanged.
 */

export { typographyCssVars } from "@brainstorm-os/sdk/typography";

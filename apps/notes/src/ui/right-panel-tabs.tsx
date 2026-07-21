/**
 * Right-panel tab strip (B11.9) — thin bridge over the shared
 * `@brainstorm-os/editor` `CommentsRightPanel` (extracted at copy two when
 * Journal became the second consumer), keeping Notes' established symbol
 * names so `app.tsx` doesn't churn.
 */

export {
	CommentsRightPanel as NotesRightPanel,
	RightPanelTab as RightTab,
} from "@brainstorm-os/editor";

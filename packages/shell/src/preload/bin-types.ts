/**
 * Bin (Trash) types, isolated from `preload/index.ts` so the renderer
 * can `import` them without dragging the preload's `electron` import
 * into the renderer bundle (same boundary reason as `marketplace-types`).
 *
 * Structurally identical to `main/bin/bin-service.ts`'s `BinItem` — the
 * IPC payload contract. The two declarations are deliberately separate
 * (main must not be pulled into preload, electron must not be pulled
 * into the renderer); they are kept in lock-step by the `bin:list`
 * round-trip test.
 */

import type { Icon } from "@brainstorm-os/sdk-types";

export type BinItem = {
	id: string;
	type: string;
	title: string;
	icon: Icon | null;
	deletedAt: number;
};

/**
 * Local mirror of the universal icon shape from
 *  / `@brainstorm-os/sdk-types`.
 *
 * Same arrangement as apps/database/src/types/icon.ts — the SDK exposes
 * this canonically but the graph app doesn't take a runtime SDK dep yet
 * (Stage 9.13.1 scaffold). Swap to the canonical import when the SDK is
 * wired in 9.13.2.
 */

export enum IconKind {
	Pack = "pack",
	Emoji = "emoji",
	Image = "image",
}

export type Icon =
	| { kind: IconKind.Pack; value: string; color?: string }
	| { kind: IconKind.Emoji; value: string }
	| { kind: IconKind.Image; value: string };

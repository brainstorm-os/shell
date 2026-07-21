/**
 * `useVaultFiles()` — the library sidebar's data source. Reads the vault's
 * previewable `File/v1` rows live through the ONE shared reactivity stack
 * (`useVaultEntities`, which owns the change subscription + coalescing) and
 * filters the whole-vault snapshot to the file rows — never a hand-rolled
 * `onChange → list → setState` loop (per [[entity-query-reactivity-layer]]).
 *
 * Preview holds the `entities.read:*` wildcard, so the whole-vault list
 * resolves; a build without `vaultEntities` (standalone preview) gets the
 * empty snapshot and an empty sidebar, no special-casing the caller.
 */

import { useVaultEntities } from "@brainstorm-os/react-yjs";
import { useMemo } from "react";
import type { PreviewFile } from "../demo/dataset";
import { FILE_ENTITY_TYPE, previewFilesFromEntities } from "../logic/vault-files";
import type { PreviewRuntime } from "./runtime";

export function useVaultFiles(runtime: PreviewRuntime | undefined): readonly PreviewFile[] {
	const vaultEntities = runtime?.services?.vaultEntities ?? null;
	const snapshot = useVaultEntities(vaultEntities);
	return useMemo(
		() => previewFilesFromEntities(snapshot.entities.filter((e) => e.type === FILE_ENTITY_TYPE)),
		[snapshot],
	);
}

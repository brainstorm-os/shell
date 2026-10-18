import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Total on-disk bytes under `vaultPath`, excluding `exclude` (history itself,
 *  so the OQ-VH-3 cap never grows by feeding on its own files). Unreadable
 *  entries count as zero; symlinks are not followed. Yields between
 *  directories so a large vault never pins the main loop. */
export async function measureVaultBytes(
	vaultPath: string,
	exclude: readonly string[],
): Promise<number> {
	const skip = new Set(exclude.map((p) => resolve(p)));
	let total = 0;
	const stack = [resolve(vaultPath)];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		if (skip.has(dir)) continue;
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const path = join(dir, name);
			try {
				const info = await lstat(path);
				if (info.isDirectory()) stack.push(path);
				else if (info.isFile()) total += info.size;
			} catch {
				// vanished mid-walk
			}
		}
		await new Promise<void>((r) => setImmediate(r));
	}
	return total;
}

import type { IconUploadService } from "./picker";

/** The minimum of the runtime's `services.icons` the picker needs — structural,
 *  so each app's narrow runtime type (and the full `IconsService`) both fit. */
export type IconUploadSource = {
	uploadBytes(filename: string, bytes: Uint8Array): Promise<{ url: string; thumbUrl: string }>;
	list(): Promise<ReadonlyArray<{ url: string; thumbUrl: string }>>;
};

/** Adapt `services.icons` into the picker's upload backing. This is the one
 *  adapter every host goes through: Notes and Contacts each hand-rolled it
 *  while six DOM-hosted apps passed nothing, leaving their Upload and Library
 *  tabs as permanent placeholders (F-524). `undefined` in → `undefined` out,
 *  so a host without the service keeps the placeholder path. */
export function iconUploadFromIcons(
	icons: IconUploadSource | null | undefined,
): IconUploadService | undefined {
	if (!icons) return undefined;
	return {
		upload: (filename, bytes) => icons.uploadBytes(filename, bytes),
		list: async () => (await icons.list()).map((e) => ({ url: e.url, thumbUrl: e.thumbUrl })),
	};
}

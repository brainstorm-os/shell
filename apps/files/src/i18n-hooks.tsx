import { type TFunction } from "@brainstorm/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm/sdk/i18n-react";
import { DEFAULTS, type FilesManifest, LOCALE_PACK_IMPORTERS } from "./i18n";

export function useFilesT(runtime?: LocaleRuntime | null): TFunction<FilesManifest> {
	return useLocalePackT(DEFAULTS, LOCALE_PACK_IMPORTERS, runtime);
}
/**
 * The embedded-list block's own catalog. The block is a self-contained IIFE
 * inlined into a sandboxed frame, so it can't lazy-load the app's locale
 * packs and the block runtime carries no locale; it bundles just its few
 * strings and picks the frame's UI language (`navigator.language`, which the
 * jail inherits from the shell process), English as the backstop.
 */

import {
	SOURCE_LANGUAGE,
	type TFunction,
	type TParams,
	createT,
	localeFallbackChain,
} from "@brainstorm-os/sdk/i18n";

const EN = {
	"embed.fallbackTitle": "Database",
	"embed.new": "+ New",
	"embed.newIn": "New item in {name}",
	"embed.createFailed": "Couldn't create",
	"embed.empty": "No items yet",
	"embed.loadFailed": "Couldn't load this database.",
	"embed.locked": "{name} is locked — unlock it to add items",
};

type EmbedManifest = typeof EN;
export type EmbedKey = keyof EmbedManifest;

export const EMBED_PACKS: Readonly<Record<string, EmbedManifest>> = {
	de: {
		"embed.fallbackTitle": "Datenbank",
		"embed.new": "+ Neu",
		"embed.newIn": "Neues Element in {name}",
		"embed.createFailed": "Erstellen fehlgeschlagen",
		"embed.empty": "Noch keine Elemente",
		"embed.loadFailed": "Diese Datenbank konnte nicht geladen werden.",
		"embed.locked": "{name} ist gesperrt – entsperren, um Elemente hinzuzufügen",
	},
	es: {
		"embed.fallbackTitle": "Base de datos",
		"embed.new": "+ Nuevo",
		"embed.newIn": "Nuevo elemento en {name}",
		"embed.createFailed": "No se pudo crear",
		"embed.empty": "Aún no hay elementos",
		"embed.loadFailed": "No se pudo cargar esta base de datos.",
		"embed.locked": "{name} está bloqueada: desbloquéala para añadir elementos",
	},
	fr: {
		"embed.fallbackTitle": "Base de données",
		"embed.new": "+ Nouveau",
		"embed.newIn": "Nouvel élément dans {name}",
		"embed.createFailed": "Création impossible",
		"embed.empty": "Aucun élément pour l'instant",
		"embed.loadFailed": "Impossible de charger cette base de données.",
		"embed.locked": "{name} est verrouillée — déverrouillez-la pour ajouter des éléments",
	},
	it: {
		"embed.fallbackTitle": "Database",
		"embed.new": "+ Nuovo",
		"embed.newIn": "Nuovo elemento in {name}",
		"embed.createFailed": "Impossibile creare",
		"embed.empty": "Ancora nessun elemento",
		"embed.loadFailed": "Impossibile caricare questo database.",
		"embed.locked": "{name} è bloccato: sbloccalo per aggiungere elementi",
	},
	pt: {
		"embed.fallbackTitle": "Banco de dados",
		"embed.new": "+ Novo",
		"embed.newIn": "Novo item em {name}",
		"embed.createFailed": "Não foi possível criar",
		"embed.empty": "Ainda não há itens",
		"embed.loadFailed": "Não foi possível carregar este banco de dados.",
		"embed.locked": "{name} está bloqueado — desbloqueie para adicionar itens",
	},
};

export function createEmbedT(language: string): TFunction<EmbedManifest> {
	for (const tag of localeFallbackChain(language)) {
		const pack = EMBED_PACKS[tag];
		if (pack) return createT(EN, pack);
	}
	return createT(EN);
}

const embedT = createEmbedT(
	(typeof navigator === "undefined" ? undefined : navigator.language) || SOURCE_LANGUAGE,
);

export function t(key: EmbedKey, params?: TParams): string {
	return embedT(key, params);
}

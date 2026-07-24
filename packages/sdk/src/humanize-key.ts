/**
 * Property-key humanization — `startDate` → "Start date", `due_date` → "Due
 * date", `url` → "URL". Shared by every surface that has to label a raw
 * property key with no registered `PropertyDef` behind it: the Database's
 * inspector / view settings, the Files property rows, and the Agent's proposed
 * database-row cards (Agent-11d).
 *
 * A registered def's `name` always wins where one exists — this is the fallback
 * that keeps an un-catalogued column legible rather than showing `dueAt`.
 */

const LABEL_OVERRIDES: Record<string, string> = {
	id: "ID",
	url: "URL",
	uri: "URI",
	uuid: "UUID",
	api: "API",
	html: "HTML",
	css: "CSS",
	json: "JSON",
};

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

export function humanizeKey(key: string): string {
	if (!key) return key;
	const tokens = key
		.replace(/[_-]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	if (tokens.length === 0) return key;
	const first = tokens.shift() as string;
	const head = LABEL_OVERRIDES[first] ?? capitalize(first);
	const tail = tokens.map((token) => LABEL_OVERRIDES[token] ?? token).join(" ");
	return tail ? `${head} ${tail}` : head;
}

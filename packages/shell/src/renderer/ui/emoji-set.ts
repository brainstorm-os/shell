/**
 * Curated emoji set + filename mapper for the IconPicker's "Emoji" tab.
 *
 * Rendering strategy: each emoji has a WebP asset bundled with the shell at
 * `packages/shell/art/emoji/<codepoints>.webp` (iamcal/emoji-data
 * img-apple-160 re-encoded WebP q80 — ~16 MB total, down from ~92 MB
 * PNG). The renderer references them via the `brainstorm://emoji/<file>`
 * protocol registered in `main/index.ts`, which serves cross-platform-
 * consistent Apple-style emoji regardless of the user's OS or system font.
 *
 * The mapping char → filename follows iamcal's convention: codepoints in
 * lowercase hex joined with `-`, including the U+FE0F variation selector
 * where it's part of the canonical sequence. The util below computes the
 * filename from the char at runtime — no separate codepoint table needed.
 */

export type EmojiEntry = {
	char: string;
	keywords: string;
};

export type EmojiCategory = {
	id: string;
	label: string;
	emojis: readonly EmojiEntry[];
};

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
	{
		id: "smileys",
		label: "Smileys",
		emojis: [
			{ char: "😀", keywords: "grin smile happy" },
			{ char: "😄", keywords: "smile happy joy" },
			{ char: "😁", keywords: "beam smile teeth" },
			{ char: "😂", keywords: "laugh cry joy" },
			{ char: "🤣", keywords: "rofl laugh roll" },
			{ char: "😊", keywords: "blush smile happy" },
			{ char: "😇", keywords: "angel halo innocent" },
			{ char: "🙂", keywords: "slight smile" },
			{ char: "😉", keywords: "wink" },
			{ char: "😍", keywords: "heart eyes love" },
			{ char: "🥰", keywords: "smiling hearts love" },
			{ char: "😘", keywords: "kiss" },
			{ char: "🤔", keywords: "thinking ponder hmm" },
			{ char: "😎", keywords: "cool sunglasses" },
			{ char: "🤓", keywords: "nerd glasses" },
			{ char: "🥳", keywords: "party celebrate" },
			{ char: "😴", keywords: "sleep zzz" },
			{ char: "🤯", keywords: "mind blown shock" },
			{ char: "😱", keywords: "scream shock" },
			{ char: "😢", keywords: "sad cry tear" },
			{ char: "😡", keywords: "angry rage" },
			{ char: "🤩", keywords: "star struck excited" },
		],
	},
	{
		id: "people",
		label: "People",
		emojis: [
			{ char: "👋", keywords: "wave hi hello" },
			{ char: "👍", keywords: "thumbs up like" },
			{ char: "👎", keywords: "thumbs down dislike" },
			{ char: "👏", keywords: "clap applause" },
			{ char: "🙏", keywords: "pray please thanks" },
			{ char: "💪", keywords: "flex muscle strong" },
			{ char: "🤝", keywords: "handshake agree" },
			{ char: "✋", keywords: "raised hand stop" },
			{ char: "🤚", keywords: "back hand raise" },
			{ char: "👀", keywords: "eyes look watch" },
			{ char: "👤", keywords: "person silhouette" },
			{ char: "👥", keywords: "people group team" },
			{ char: "👶", keywords: "baby" },
			{ char: "🧑", keywords: "person adult" },
		],
	},
	{
		id: "animals",
		label: "Animals & nature",
		emojis: [
			{ char: "🐶", keywords: "dog puppy" },
			{ char: "🐱", keywords: "cat kitten" },
			{ char: "🦊", keywords: "fox" },
			{ char: "🐻", keywords: "bear" },
			{ char: "🐼", keywords: "panda" },
			{ char: "🐧", keywords: "penguin" },
			{ char: "🦉", keywords: "owl wise" },
			{ char: "🐢", keywords: "turtle slow" },
			{ char: "🐠", keywords: "fish tropical" },
			{ char: "🌱", keywords: "seedling sprout plant" },
			{ char: "🌳", keywords: "tree forest" },
			{ char: "🌲", keywords: "evergreen tree" },
			{ char: "🌵", keywords: "cactus" },
			{ char: "🌷", keywords: "tulip flower" },
			{ char: "🌹", keywords: "rose flower red" },
			{ char: "🌻", keywords: "sunflower" },
			{ char: "🌍", keywords: "earth globe world" },
			{ char: "☀️", keywords: "sun bright sunny" },
			{ char: "🌙", keywords: "moon crescent night" },
			{ char: "⭐", keywords: "star" },
			{ char: "✨", keywords: "sparkles magic" },
			{ char: "⚡", keywords: "lightning bolt fast" },
			{ char: "🔥", keywords: "fire hot trending" },
			{ char: "❄️", keywords: "snowflake cold winter" },
			{ char: "🌈", keywords: "rainbow colors" },
		],
	},
	{
		id: "food",
		label: "Food & drink",
		emojis: [
			{ char: "☕", keywords: "coffee tea hot drink" },
			{ char: "🍵", keywords: "tea green matcha" },
			{ char: "🍷", keywords: "wine red glass" },
			{ char: "🍺", keywords: "beer pint" },
			{ char: "🍕", keywords: "pizza slice" },
			{ char: "🍔", keywords: "burger hamburger" },
			{ char: "🌮", keywords: "taco" },
			{ char: "🍣", keywords: "sushi japanese" },
			{ char: "🍎", keywords: "apple red fruit" },
			{ char: "🍌", keywords: "banana fruit" },
			{ char: "🍓", keywords: "strawberry fruit" },
			{ char: "🥑", keywords: "avocado" },
			{ char: "🥕", keywords: "carrot vegetable" },
			{ char: "🍫", keywords: "chocolate bar" },
			{ char: "🍰", keywords: "cake slice" },
			{ char: "🎂", keywords: "birthday cake" },
		],
	},
	{
		id: "objects",
		label: "Objects",
		emojis: [
			{ char: "📝", keywords: "note pencil memo" },
			{ char: "📔", keywords: "notebook journal" },
			{ char: "📕", keywords: "book closed red" },
			{ char: "📖", keywords: "book open read" },
			{ char: "📚", keywords: "books library" },
			{ char: "📓", keywords: "notebook composition" },
			{ char: "📇", keywords: "card index" },
			{ char: "📁", keywords: "folder file" },
			{ char: "📂", keywords: "folder open" },
			{ char: "📅", keywords: "calendar date" },
			{ char: "📆", keywords: "calendar tear off" },
			{ char: "⏰", keywords: "alarm clock time" },
			{ char: "⏱️", keywords: "stopwatch timer" },
			{ char: "🕐", keywords: "clock time hour" },
			{ char: "💡", keywords: "lightbulb idea bright" },
			{ char: "🔑", keywords: "key password" },
			{ char: "🔒", keywords: "lock secure private" },
			{ char: "🔓", keywords: "lock open unlocked" },
			{ char: "🔍", keywords: "magnifying glass search" },
			{ char: "🔗", keywords: "link chain" },
			{ char: "📎", keywords: "paperclip attach" },
			{ char: "✂️", keywords: "scissors cut" },
			{ char: "✏️", keywords: "pencil write edit" },
			{ char: "🖊️", keywords: "pen write" },
			{ char: "💻", keywords: "laptop computer" },
			{ char: "📱", keywords: "phone mobile" },
			{ char: "🎧", keywords: "headphones audio music" },
			{ char: "📷", keywords: "camera photo" },
			{ char: "🎥", keywords: "video camera movie" },
			{ char: "🎮", keywords: "game controller gaming" },
			{ char: "🎵", keywords: "music note song" },
			{ char: "📊", keywords: "chart bar graph data" },
			{ char: "📈", keywords: "chart trend up growth" },
			{ char: "📉", keywords: "chart trend down" },
			{ char: "💰", keywords: "money bag wealth" },
			{ char: "💳", keywords: "credit card payment" },
		],
	},
	{
		id: "symbols",
		label: "Symbols",
		emojis: [
			{ char: "❤️", keywords: "heart love red" },
			{ char: "🧡", keywords: "heart orange" },
			{ char: "💛", keywords: "heart yellow" },
			{ char: "💚", keywords: "heart green" },
			{ char: "💙", keywords: "heart blue" },
			{ char: "💜", keywords: "heart purple" },
			{ char: "🖤", keywords: "heart black" },
			{ char: "🤍", keywords: "heart white" },
			{ char: "💔", keywords: "broken heart" },
			{ char: "✅", keywords: "check mark done complete" },
			{ char: "❌", keywords: "cross x cancel error" },
			{ char: "⚠️", keywords: "warning caution alert" },
			{ char: "❓", keywords: "question mark help" },
			{ char: "❗", keywords: "exclamation alert" },
			{ char: "🚀", keywords: "rocket launch fast" },
			{ char: "🎯", keywords: "target goal bullseye" },
			{ char: "🏆", keywords: "trophy award win" },
			{ char: "🎉", keywords: "party celebrate" },
			{ char: "🎁", keywords: "gift present" },
			{ char: "💎", keywords: "gem diamond precious" },
			{ char: "👑", keywords: "crown king queen" },
		],
	},
	{
		id: "travel",
		label: "Travel & places",
		emojis: [
			{ char: "🏠", keywords: "home house" },
			{ char: "🏢", keywords: "office building" },
			{ char: "🏫", keywords: "school building" },
			{ char: "🏥", keywords: "hospital health" },
			{ char: "✈️", keywords: "airplane travel fly" },
			{ char: "🚗", keywords: "car automobile drive" },
			{ char: "🚲", keywords: "bicycle bike" },
			{ char: "🚆", keywords: "train" },
			{ char: "🗺️", keywords: "map world geography" },
			{ char: "🗻", keywords: "mountain peak fuji" },
		],
	},
];

export const ALL_EMOJI: readonly EmojiEntry[] = EMOJI_CATEGORIES.flatMap((c) => c.emojis);

/** Turn a unicode emoji character (possibly multi-codepoint with ZWJ + VS-16)
 *  into the iamcal/emoji-data filename: lowercase hex codepoints (zero-padded
 *  to a minimum of 4 digits, matching the art pack) joined with `-`, plus
 *  `.webp`. Examples:
 *    "👋"      → "1f44b.webp"
 *    "❤️"      → "2764-fe0f.webp"
 *    "©️"      → "00a9-fe0f.webp"
 *    "0️⃣"     → "0030-fe0f-20e3.webp"
 *    "👨‍💻"   → "1f468-200d-1f4bb.webp"
 *  Spread iterates by code-point (not UTF-16 code-unit), so surrogate pairs
 *  collapse correctly. The `padStart(4)` is load-bearing for BMP emoji < U+1000
 *  (keycaps 0️⃣–9️⃣ #️⃣ *️⃣, ©️, ®️) — without it they 404 and render blank. */
export function emojiFilename(char: string): string {
	const parts: string[] = [];
	for (const c of char) {
		const cp = c.codePointAt(0);
		if (cp === undefined) continue;
		parts.push(cp.toString(16).padStart(4, "0"));
	}
	return `${parts.join("-")}.webp`;
}

export function emojiUrl(char: string): string {
	return `brainstorm://emoji/${emojiFilename(char)}`;
}

export function searchEmoji(query: string): readonly EmojiEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return ALL_EMOJI;
	return ALL_EMOJI.filter((e) => e.keywords.includes(q));
}

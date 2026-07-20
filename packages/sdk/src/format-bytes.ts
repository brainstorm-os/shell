/**
 * Human byte sizes for file-ish surfaces (Files inspector/storage/list rows,
 * Mailbox attachment chips). Extracted from Files when Mailbox became the
 * second consumer.
 *
 * Deliberately unit-suffixed in English rather than `Intl`-formatted: the
 * suffixes are compact symbols the surrounding UI treats as data, and an
 * `Intl.NumberFormat` unit style would localise them inconsistently with the
 * catalog strings around them. Revisit if a locale demands translated units.
 */

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

export function formatBytes(size: number): string {
	if (!Number.isFinite(size) || size < 0) return "—";
	if (size < KIB) return `${size} B`;
	if (size < MIB) return `${(size / KIB).toFixed(1)} KB`;
	if (size < GIB) return `${(size / MIB).toFixed(1)} MB`;
	return `${(size / GIB).toFixed(2)} GB`;
}

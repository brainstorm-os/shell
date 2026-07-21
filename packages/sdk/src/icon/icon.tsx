/**
 * `@brainstorm-os/sdk/icon` — the app-side `<Icon>`, mirroring the shell's
 * common Icon component (`packages/shell/src/renderer/ui/icon.tsx`): same
 * `IconName` enum, same glyph mapping, same default size (16) and
 * unknown-name behaviour (warn in dev, render nothing).
 *
 * Backed by `@phosphor-icons/react`. The pure-DOM twin
 * (`createIconElement`, in `./create-icon-element.ts`) renders the SAME
 * glyph without React so plain-DOM apps don't pull React.
 */

import {
	AddressBook,
	Archive,
	ArrowClockwise,
	ArrowCounterClockwise,
	ArrowRight,
	ArrowSquareOut,
	BookOpen,
	Calendar,
	CaretDown,
	CaretLeft,
	CaretRight,
	CaretUp,
	ChatCircle,
	Check,
	CheckCircle,
	CheckSquare,
	ClockCounterClockwise,
	Copy,
	Cube,
	DotsSixVertical,
	DotsThree,
	DownloadSimple,
	Envelope,
	FileText,
	FolderPlus,
	FolderSimple,
	Gear,
	Globe,
	Hash,
	Info,
	Link as LinkGlyph,
	ListChecks,
	Lock,
	MagnifyingGlass,
	Minus,
	Moon,
	Palette,
	Paperclip,
	PencilSimple,
	Phone,
	type Icon as PhosphorIcon,
	type IconWeight as PhosphorWeight,
	Plus,
	PushPin,
	PushPinSlash,
	SignOut,
	Sparkle,
	SquaresFour,
	Star,
	Storefront,
	Sun,
	Tag,
	TextT,
	Trash,
	Tray,
	WarningCircle,
	X,
} from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import { IconDirection, IconName, IconWeight } from "./icon-registry";
import { useIcon } from "./use-icon";

const ICON_VIEWBOX = "0 0 256 256";

const ICON_REGISTRY: Record<IconName, PhosphorIcon> = {
	[IconName.Settings]: Gear,
	[IconName.Plus]: Plus,
	[IconName.Close]: X,
	[IconName.CaretLeft]: CaretLeft,
	[IconName.CaretRight]: CaretRight,
	[IconName.CaretDown]: CaretDown,
	[IconName.CaretUp]: CaretUp,
	[IconName.Minus]: Minus,
	[IconName.DragHandle]: DotsSixVertical,
	[IconName.More]: DotsThree,
	[IconName.ArrowRight]: ArrowRight,
	[IconName.Check]: Check,
	[IconName.OpenExternal]: ArrowSquareOut,
	[IconName.Info]: Info,
	[IconName.Search]: MagnifyingGlass,
	[IconName.Folder]: FolderSimple,
	[IconName.Lock]: Lock,
	[IconName.Sun]: Sun,
	[IconName.Moon]: Moon,
	[IconName.Palette]: Palette,
	[IconName.CheckCircle]: CheckCircle,
	[IconName.Warning]: WarningCircle,
	[IconName.App]: SquaresFour,
	[IconName.Entity]: Cube,
	[IconName.View]: FileText,
	[IconName.AddressBook]: AddressBook,
	[IconName.SignOut]: SignOut,
	[IconName.Sparkle]: Sparkle,
	[IconName.Chat]: ChatCircle,
	[IconName.Storefront]: Storefront,
	[IconName.Trash]: Trash,
	[IconName.Pin]: PushPin,
	[IconName.PinSlash]: PushPinSlash,
	[IconName.Copy]: Copy,
	[IconName.Download]: DownloadSimple,
	[IconName.Pencil]: PencilSimple,
	[IconName.Update]: ArrowCounterClockwise,
	[IconName.FolderPlus]: FolderPlus,
	[IconName.Reload]: ArrowClockwise,
	[IconName.History]: ClockCounterClockwise,
	[IconName.Star]: Star,
	[IconName.Inbox]: Tray,
	[IconName.Read]: CheckCircle,
	[IconName.Archive]: Archive,
	[IconName.Tag]: Tag,
	[IconName.KindBoolean]: CheckSquare,
	[IconName.KindDate]: Calendar,
	[IconName.KindDictionary]: BookOpen,
	[IconName.KindEmail]: Envelope,
	[IconName.KindFile]: Paperclip,
	[IconName.KindLink]: LinkGlyph,
	[IconName.KindMultiSelect]: ListChecks,
	[IconName.KindNumber]: Hash,
	[IconName.KindPhone]: Phone,
	[IconName.KindSelect]: Tag,
	[IconName.KindText]: TextT,
	[IconName.KindUrl]: Globe,
};

export type IconProps = {
	name: IconName | `${IconName}`;
	/** Pixel size, applied to both width and height. Defaults to 16. */
	size?: number;
	/** Optional CSS color override; defaults to `currentColor`. */
	color?: string;
	/** Phosphor weight. Defaults to `regular`. */
	weight?: IconWeight | `${IconWeight}`;
	/** Whether the glyph carries inline-axis direction. `Inline` stamps the
	 *  SVG with `data-icon-direction="inline"` so the global RTL mirror rule
	 *  flips it; default `Auto` leaves the glyph bidirectional. Stage 12.5. */
	direction?: IconDirection | `${IconDirection}`;
	className?: string;
	style?: CSSProperties;
};

export function Icon({
	name,
	size = 16,
	color,
	weight = IconWeight.Regular,
	direction = IconDirection.Auto,
	className,
	style,
}: IconProps) {
	const directionAttr = direction === IconDirection.Inline ? "inline" : undefined;
	// An installed IconPack/v1 overrides this canonical name; otherwise
	// fall through to the built-in Phosphor glyph (default: no pack →
	// identical to before). Hook is unconditional (before any return).
	const override = useIcon(String(name));
	if (override) {
		return (
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox={ICON_VIEWBOX}
				width={size}
				height={size}
				fill={color ?? "currentColor"}
				aria-hidden="true"
				focusable="false"
				data-icon-direction={directionAttr}
				className={className}
				style={style}
				// Pack glyph markup ships in the (validated) IconPack entity,
				// not user input; it is inner SVG on the shared 256 grid.
				// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted IconPack/v1 asset, not user content
				dangerouslySetInnerHTML={{ __html: override }}
			/>
		);
	}
	const Glyph = ICON_REGISTRY[name as IconName];
	if (!Glyph) {
		if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
			console.warn(`[icon] unknown icon name: ${String(name)}`);
		}
		return null;
	}
	return (
		<Glyph
			size={size}
			color={color ?? "currentColor"}
			weight={weight as PhosphorWeight}
			data-icon-direction={directionAttr}
			className={className}
			style={style}
		/>
	);
}

/**
 * Common Icon component — single entry point for every interface glyph.
 * Default size 16x16 (per user direction 2026-05-12).
 *
 * Backed by `@phosphor-icons/react` — the curated, tree-shakable icon pack
 * documented in [ §Icon packs] and
 * . Adding a new glyph: import the Phosphor
 * component, register it in `ICON_REGISTRY` against an enum entry, done.
 *
 * Every renderer surface goes through this component — never reach for a
 * Phosphor symbol directly (the indirection lets us swap packs later, batch
 * accessibility props, and enforce one source of truth for sizing and color).
 */

import {
	Archive,
	ArrowCounterClockwise,
	ArrowRight,
	ArrowUpRight,
	Bell,
	BookOpen,
	Browsers,
	Buildings,
	Calendar,
	Camera,
	CameraSlash,
	CaretDown,
	CaretUp,
	CheckCircle,
	CheckSquare,
	CircleHalf,
	Clock as ClockGlyph,
	Cloud,
	CloudSlash,
	Copy,
	CreditCard,
	Crown,
	Cube,
	DeviceMobile,
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
	Heart,
	Info,
	Keyboard,
	Laptop,
	Lightning,
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
	Plus,
	Prohibit,
	PushPin,
	PushPinSlash,
	QrCode,
	Question,
	ShieldCheck,
	SignOut,
	Sparkle,
	SquaresFour,
	Star,
	Storefront,
	Sun,
	Tag,
	TextT,
	Trash,
	WarningCircle,
	WifiHigh,
	X,
} from "@phosphor-icons/react";
import type { CSSProperties } from "react";

export enum IconName {
	Settings = "settings",
	Plus = "plus",
	Close = "close",
	Info = "info",
	Search = "search",
	Folder = "folder",
	Lock = "lock",
	Sun = "sun",
	Moon = "moon",
	AppearanceAuto = "appearance-auto",
	Palette = "palette",
	CheckCircle = "check-circle",
	Warning = "warning",
	App = "app",
	Entity = "entity",
	View = "view",
	SignOut = "sign-out",
	Sparkle = "sparkle",
	Storefront = "storefront",
	Trash = "trash",
	Restore = "restore",
	Update = "update",
	FolderPlus = "folder-plus",
	Archive = "archive",
	ArrowRight = "arrow-right",
	ArrowUpRight = "arrow-up-right",
	Pin = "pin",
	Unpin = "unpin",
	Keyboard = "keyboard",
	Question = "question",
	// Welcome template-gallery glyphs (vault-creation use-case tiles).
	Tasks = "tasks",
	Book = "book",
	Calendar = "calendar",
	// Shell-settings glyphs (settings overhaul — Interface / Language & Region /
	// Notifications sections + the header notification bell).
	Bell = "bell",
	Globe = "globe",
	Interface = "interface",
	Clock = "clock",
	// Device-pairing glyphs (Stage 10.5b — Settings → Devices).
	DeviceMobile = "device-mobile",
	Laptop = "laptop",
	QrCode = "qr-code",
	Camera = "camera",
	CameraSlash = "camera-slash",
	// Sync-status glyphs (Stage 10.7 — dashboard sync chip + Settings → Sync).
	Cloud = "cloud",
	CloudSlash = "cloud-slash",
	// Network egress glyphs (Net-1f — Settings → Privacy → Network).
	Network = "network",
	Prohibit = "prohibit",
	Download = "download",
	Copy = "copy",
	Pencil = "pencil",
	// Membership / pricing glyphs (Settings → Membership).
	Star = "star",
	CreditCard = "credit-card",
	Crown = "crown",
	Lightning = "lightning",
	Heart = "heart",
	Buildings = "buildings",
	ShieldCheck = "shield-check",
	CaretDown = "caret-down",
	CaretUp = "caret-up",
	Minus = "minus",
	More = "more",
	DragHandle = "drag-handle",
	// Property-kind glyphs — one per `PropertyKind` value plus the
	// dictionary glyph used in the Settings → Data tab. Keep
	// alphabetical by kind for predictability.
	KindBoolean = "kind-boolean",
	KindDate = "kind-date",
	KindDictionary = "kind-dictionary",
	KindEmail = "kind-email",
	KindFile = "kind-file",
	KindLink = "kind-link",
	KindMultiSelect = "kind-multi-select",
	KindNumber = "kind-number",
	KindPhone = "kind-phone",
	KindSelect = "kind-select",
	KindText = "kind-text",
	KindUrl = "kind-url",
}

const ICON_REGISTRY: Record<IconName, PhosphorIcon> = {
	[IconName.Settings]: Gear,
	[IconName.Plus]: Plus,
	[IconName.Close]: X,
	[IconName.Info]: Info,
	[IconName.Search]: MagnifyingGlass,
	[IconName.Folder]: FolderSimple,
	[IconName.Lock]: Lock,
	[IconName.Sun]: Sun,
	[IconName.Moon]: Moon,
	[IconName.AppearanceAuto]: CircleHalf,
	[IconName.Palette]: Palette,
	[IconName.CheckCircle]: CheckCircle,
	[IconName.Warning]: WarningCircle,
	[IconName.App]: SquaresFour,
	[IconName.Entity]: Cube,
	[IconName.View]: FileText,
	[IconName.SignOut]: SignOut,
	[IconName.Sparkle]: Sparkle,
	[IconName.Storefront]: Storefront,
	[IconName.Trash]: Trash,
	[IconName.Restore]: ArrowCounterClockwise,
	[IconName.Update]: ArrowCounterClockwise,
	[IconName.FolderPlus]: FolderPlus,
	[IconName.ArrowRight]: ArrowRight,
	[IconName.ArrowUpRight]: ArrowUpRight,
	[IconName.Archive]: Archive,
	[IconName.Pin]: PushPin,
	[IconName.Unpin]: PushPinSlash,
	[IconName.Keyboard]: Keyboard,
	[IconName.Question]: Question,
	[IconName.Tasks]: ListChecks,
	[IconName.Book]: BookOpen,
	[IconName.Calendar]: Calendar,
	[IconName.Bell]: Bell,
	[IconName.Globe]: Globe,
	[IconName.Interface]: Browsers,
	[IconName.Clock]: ClockGlyph,
	[IconName.DeviceMobile]: DeviceMobile,
	[IconName.Laptop]: Laptop,
	[IconName.QrCode]: QrCode,
	[IconName.Camera]: Camera,
	[IconName.CameraSlash]: CameraSlash,
	[IconName.Cloud]: Cloud,
	[IconName.CloudSlash]: CloudSlash,
	[IconName.Network]: WifiHigh,
	[IconName.Prohibit]: Prohibit,
	[IconName.Download]: DownloadSimple,
	[IconName.Copy]: Copy,
	[IconName.Pencil]: PencilSimple,
	// Membership glyphs.
	[IconName.Star]: Star,
	[IconName.CreditCard]: CreditCard,
	[IconName.Crown]: Crown,
	[IconName.Lightning]: Lightning,
	[IconName.Heart]: Heart,
	[IconName.Buildings]: Buildings,
	[IconName.ShieldCheck]: ShieldCheck,
	[IconName.CaretDown]: CaretDown,
	[IconName.CaretUp]: CaretUp,
	[IconName.Minus]: Minus,
	[IconName.More]: DotsThree,
	[IconName.DragHandle]: DotsSixVertical,
	// Kind glyphs.
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
	/** Pixel size, applied to both width and height. Defaults to 20. */
	size?: number;
	/** Optional CSS color override; defaults to `currentColor`. */
	color?: string;
	/** Phosphor weight — keep it consistent across the product unless a
	 *  surface genuinely needs a different one. Defaults to `regular`. */
	weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
	className?: string;
	style?: CSSProperties;
};

export function Icon({ name, size = 16, color, weight = "regular", className, style }: IconProps) {
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
			weight={weight}
			className={className}
			style={style}
		/>
	);
}

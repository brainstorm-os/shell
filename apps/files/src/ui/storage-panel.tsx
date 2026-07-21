/**
 * StoragePanel — the Files "Storage" inventory (the answer to "what's taking
 * up vault disk"). Lists every stored blob the shell aggregates across the
 * encrypted asset store + the cover / wallpaper / icon content stores
 * (`files.listStorageInventory`), largest-first, with a running total.
 *
 * Deliberately an overlay (shared `<Popover>`) rather than a new content
 * view: it reads across stores without touching the folder/store model, so
 * it's additive and self-contained. Preview / reclaim land as follow-ups.
 */

import type { StoredAsset } from "@brainstorm-os/sdk-types";
import { StoredAssetKind } from "@brainstorm-os/sdk-types";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { Popover, PopoverSize } from "@brainstorm-os/sdk/popover";
import { type ReactElement, useEffect, useState } from "react";
import { plural, t } from "../i18n";
import { formatBytes } from "./entity-view";
import "./storage-panel.css";

const KIND_LABEL = {
	[StoredAssetKind.Upload]: "brainstorm.files.storage.kind.upload",
	[StoredAssetKind.Cover]: "brainstorm.files.storage.kind.cover",
	[StoredAssetKind.Wallpaper]: "brainstorm.files.storage.kind.wallpaper",
	[StoredAssetKind.Icon]: "brainstorm.files.storage.kind.icon",
	[StoredAssetKind.Favicon]: "brainstorm.files.storage.kind.favicon",
} as const;

const KIND_ICON: Record<StoredAssetKind, IconName> = {
	[StoredAssetKind.Upload]: IconName.KindFile,
	[StoredAssetKind.Cover]: IconName.Palette,
	[StoredAssetKind.Wallpaper]: IconName.Palette,
	[StoredAssetKind.Icon]: IconName.Sparkle,
	[StoredAssetKind.Favicon]: IconName.KindLink,
};

function StorageThumb({ asset }: { asset: StoredAsset }): ReactElement {
	if (asset.mime.startsWith("image/")) {
		return (
			<img
				className="storage-row__thumb"
				src={asset.thumbUrl ?? asset.url}
				alt=""
				loading="lazy"
				draggable={false}
			/>
		);
	}
	return (
		<span className="storage-row__thumb storage-row__thumb--glyph" aria-hidden="true">
			<Icon name={KIND_ICON[asset.kind]} size={18} />
		</span>
	);
}

export function StoragePanel({
	loadInventory,
	onOpen,
	onClose,
}: {
	loadInventory: () => Promise<ReadonlyArray<StoredAsset>>;
	onOpen: (asset: StoredAsset) => void;
	onClose: () => void;
}): ReactElement {
	const [items, setItems] = useState<readonly StoredAsset[] | null>(null);

	useEffect(() => {
		let active = true;
		loadInventory()
			.then((rows) => {
				if (active) setItems(rows);
			})
			.catch(() => {
				if (active) setItems([]);
			});
		return () => {
			active = false;
		};
	}, [loadInventory]);

	const total = (items ?? []).reduce((sum, a) => sum + (a.sizeBytes > 0 ? a.sizeBytes : 0), 0);

	return (
		<Popover
			title={t("brainstorm.files.storage.title")}
			onClose={onClose}
			size={PopoverSize.Large}
			testId="storage-panel"
		>
			<div className="storage-panel">
				<p className="storage-panel__summary">
					{items === null
						? t("brainstorm.files.storage.loading")
						: `${plural(items.length, "brainstorm.files.storage.count.one", "brainstorm.files.storage.count.other")} · ${formatBytes(total)}`}
				</p>
				{items !== null && items.length === 0 ? (
					<p className="storage-panel__empty">{t("brainstorm.files.storage.empty")}</p>
				) : null}
				<ul className="storage-panel__list">
					{(items ?? []).map((asset) => {
						const openable = asset.entityId !== undefined;
						const body = (
							<>
								<StorageThumb asset={asset} />
								<span className="storage-row__name" title={asset.name}>
									{asset.name}
								</span>
								<span className="storage-row__kind">{t(KIND_LABEL[asset.kind])}</span>
								<span className="storage-row__size">
									{asset.sizeBytes >= 0 ? formatBytes(asset.sizeBytes) : "—"}
								</span>
							</>
						);
						return (
							<li key={`${asset.kind}:${asset.id}`} className="storage-row">
								{openable ? (
									<button
										type="button"
										className="storage-row__inner storage-row__open"
										onClick={() => onOpen(asset)}
										title={t("brainstorm.files.storage.openInPreview")}
									>
										{body}
									</button>
								) : (
									<div className="storage-row__inner">{body}</div>
								)}
							</li>
						);
					})}
				</ul>
			</div>
		</Popover>
	);
}

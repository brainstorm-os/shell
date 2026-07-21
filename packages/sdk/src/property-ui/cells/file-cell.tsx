/**
 * FileListCell / GalleryCell / ImageRowCell — entityRef-with-File
 * views. Accept-only until the upload API lands: dropped files surface
 * a translated "uploads pending" caption rather than being swallowed;
 * already-bound refs still render so the data shape stays
 * forward-compatible. `layout` only changes the resting chrome.
 */

import { type CellProps, type LabeledValue, isMultiValued } from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { useCallback, useMemo, useState } from "react";
import { usePropertyUiSeams } from "../use-properties";

export enum FileLayout {
	List = "list",
	Gallery = "gallery",
	ImageRow = "image-row",
}

function makeFileCell(layout: FileLayout) {
	return function FileCell(props: CellProps): JSX.Element {
		const { property, value, readOnly } = props;
		const { labels } = usePropertyUiSeams();
		const [hover, setHover] = useState(false);

		const refs = useMemo<readonly string[]>(() => {
			if (isMultiValued(property.count)) {
				const arr = Array.isArray(value) ? (value as readonly LabeledValue<string>[]) : [];
				return arr.map((el) => el.value).filter((v): v is string => typeof v === "string");
			}
			return typeof value === "string" && value.length > 0 ? [value] : [];
		}, [value, property.count]);

		const onDrop = useCallback((e: React.DragEvent) => {
			e.preventDefault();
			setHover(false);
		}, []);

		const onDragOver = useCallback(
			(e: React.DragEvent) => {
				if (readOnly) return;
				e.preventDefault();
				setHover(true);
			},
			[readOnly],
		);

		return (
			<div
				className={`bs-cell-file bs-cell-file--${layout}${hover ? " bs-cell-file--hover" : ""}`}
				onDrop={onDrop}
				onDragOver={onDragOver}
				onDragLeave={() => setHover(false)}
				aria-label={labels.fileRegion(property.name)}
			>
				{refs.length > 0 ? (
					<div className="bs-cell-file-items">
						{refs.map((id) => (
							<span key={id} className="bs-cell-file-item" title={id}>
								{id}
							</span>
						))}
					</div>
				) : (
					<span className="bs-cell-file-empty">{labels.fileEmpty}</span>
				)}
				<span className="bs-cell-file-pending">{labels.fileUploadsPending}</span>
			</div>
		);
	};
}

export const FileListCell = makeFileCell(FileLayout.List);
export const GalleryCell = makeFileCell(FileLayout.Gallery);
export const ImageRowCell = makeFileCell(FileLayout.ImageRow);

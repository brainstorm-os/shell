/**
 * Tile presets — pure math to translate a "snap this window to half / quarter
 * of a monitor" instruction into concrete bounds inside that monitor's work
 * area.
 *
 * Surfaced through `windows.tile(id, preset)` and used by the dashboard's
 * window switcher / context menu. Decoupled from Electron so it's testable
 * without spinning up a BrowserWindow.
 */

import { TilePreset } from "@brainstorm-os/protocol/window-types";
import type { MonitorInfo, WindowPlacement } from "./monitor";

export { TilePreset };

const CENTER_RATIO = 0.66;

export function tileBounds(preset: TilePreset, monitor: MonitorInfo): WindowPlacement {
	const a = monitor.workArea;
	const halfW = Math.floor(a.width / 2);
	const halfH = Math.floor(a.height / 2);
	switch (preset) {
		case TilePreset.Fill:
			return { x: a.x, y: a.y, width: a.width, height: a.height };
		case TilePreset.LeftHalf:
			return { x: a.x, y: a.y, width: halfW, height: a.height };
		case TilePreset.RightHalf:
			return { x: a.x + halfW, y: a.y, width: a.width - halfW, height: a.height };
		case TilePreset.TopHalf:
			return { x: a.x, y: a.y, width: a.width, height: halfH };
		case TilePreset.BottomHalf:
			return { x: a.x, y: a.y + halfH, width: a.width, height: a.height - halfH };
		case TilePreset.TopLeft:
			return { x: a.x, y: a.y, width: halfW, height: halfH };
		case TilePreset.TopRight:
			return { x: a.x + halfW, y: a.y, width: a.width - halfW, height: halfH };
		case TilePreset.BottomLeft:
			return { x: a.x, y: a.y + halfH, width: halfW, height: a.height - halfH };
		case TilePreset.BottomRight:
			return {
				x: a.x + halfW,
				y: a.y + halfH,
				width: a.width - halfW,
				height: a.height - halfH,
			};
		case TilePreset.Center: {
			const w = Math.floor(a.width * CENTER_RATIO);
			const h = Math.floor(a.height * CENTER_RATIO);
			return {
				x: a.x + Math.floor((a.width - w) / 2),
				y: a.y + Math.floor((a.height - h) / 2),
				width: w,
				height: h,
			};
		}
	}
}

/** Translate a window from its current monitor onto `target`, preserving the
 *  relative position + size where possible. Falls back to clamping bounds
 *  inside the target's work area when the source bounds wouldn't fit. */
export function projectOntoMonitor(
	source: WindowPlacement,
	from: MonitorInfo,
	to: MonitorInfo,
): WindowPlacement {
	const fx = from.workArea;
	const tx = to.workArea;
	const relX = (source.x - fx.x) / Math.max(1, fx.width);
	const relY = (source.y - fx.y) / Math.max(1, fx.height);
	const scale = Math.min(1, Math.min(tx.width / source.width, tx.height / source.height));
	const width = Math.max(320, Math.floor(source.width * scale));
	const height = Math.max(240, Math.floor(source.height * scale));
	let x = tx.x + Math.round(relX * tx.width);
	let y = tx.y + Math.round(relY * tx.height);
	x = Math.max(tx.x, Math.min(x, tx.x + tx.width - width));
	y = Math.max(tx.y, Math.min(y, tx.y + tx.height - height));
	return { x, y, width, height };
}

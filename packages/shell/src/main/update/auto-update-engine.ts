/**
 * 13.12 — AutoUpdateEngine: the shell-main orchestrator for in-app
 * (electron-updater) self-update on packaged builds.
 *
 * The engine owns the update lifecycle state machine (idle → checking →
 * available → downloading → downloaded → relaunch) and is the single
 * source the dashboard renders. It drives an injected `ManagedAutoUpdater`
 * — production binds electron-updater's `autoUpdater`
 * (`electron-auto-updater.ts`); tests bind a fake that fires the same
 * callbacks — so the whole state machine is unit-testable with no Electron
 * and no network, exactly like 13.6's `UpdateService`.
 *
 * Download + install are explicit, user-initiated steps (autoDownload is
 * off): a check only DETECTS, the user clicks Download, then relaunches to
 * install. Nothing is fetched or swapped behind their back.
 */

import {
	type AutoUpdateState,
	type UpdateChannel,
	UpdateLifecycle,
	type UpdateProgress,
} from "../../shared/update-wire-types";

/** The callbacks the engine reacts to. Mirrors the electron-updater
 *  autoUpdater events we consume, normalised to plain data. */
export type AutoUpdaterHandlers = {
	onCheckingForUpdate(): void;
	onUpdateAvailable(version: string): void;
	onUpdateNotAvailable(): void;
	onDownloadProgress(progress: UpdateProgress): void;
	onUpdateDownloaded(version: string): void;
	onError(message: string): void;
};

/** The minimal slice of electron-updater's `autoUpdater` the engine needs.
 *  Results arrive via the handlers registered in `on`, never the return
 *  values (the underlying API is event-driven). */
export type ManagedAutoUpdater = {
	setChannel(channel: UpdateChannel): void;
	checkForUpdates(): Promise<void>;
	downloadUpdate(): Promise<void>;
	/** Quit and install the staged update — relaunches, never returns. */
	quitAndInstall(): void;
	/** Register the lifecycle callbacks. Called once at construction. */
	on(handlers: AutoUpdaterHandlers): void;
};

export type AutoUpdateEngineOptions = {
	readonly updater: ManagedAutoUpdater;
	/** Resolve the persisted release channel (shared with 13.6 prefs). */
	readonly getChannel: () => Promise<UpdateChannel>;
	/** False on dev / unpackaged builds where self-update can't run. */
	readonly supported: boolean;
	/** Fired on every state transition (production: push to the dashboard
	 *  renderer over `UPDATE_STATE_EVENT`). */
	readonly onState?: (state: AutoUpdateState) => void;
};

export class AutoUpdateEngine {
	private state: AutoUpdateState;
	private readonly updater: ManagedAutoUpdater;
	private readonly getChannel: () => Promise<UpdateChannel>;
	private readonly supported: boolean;
	private readonly onState: (state: AutoUpdateState) => void;

	constructor(options: AutoUpdateEngineOptions) {
		this.updater = options.updater;
		this.getChannel = options.getChannel;
		this.supported = options.supported;
		this.onState = options.onState ?? (() => {});
		this.state = {
			lifecycle: options.supported ? UpdateLifecycle.Idle : UpdateLifecycle.Unsupported,
		};
		if (options.supported) this.registerHandlers();
	}

	getState(): AutoUpdateState {
		return this.state;
	}

	/** Detect whether a newer version exists on the persisted channel.
	 *  Total — a failure resolves to the `Error` state, never throws. */
	async check(): Promise<AutoUpdateState> {
		if (!this.supported) return this.state;
		try {
			this.updater.setChannel(await this.getChannel());
			this.transition({ lifecycle: UpdateLifecycle.Checking });
			await this.updater.checkForUpdates();
		} catch (error) {
			this.fail(error);
		}
		return this.state;
	}

	/** Begin downloading the available update. Progress + completion arrive
	 *  through the event handlers. */
	async download(): Promise<AutoUpdateState> {
		if (!this.supported) return this.state;
		const version = this.state.version;
		this.transition({
			lifecycle: UpdateLifecycle.Downloading,
			...(version !== undefined ? { version } : {}),
			progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
		});
		try {
			await this.updater.downloadUpdate();
		} catch (error) {
			this.fail(error);
		}
		return this.state;
	}

	/** Relaunch into the staged update. Only meaningful once `Downloaded`;
	 *  a no-op otherwise so a stale renderer click can't quit mid-download. */
	installNow(): void {
		if (this.state.lifecycle !== UpdateLifecycle.Downloaded) return;
		this.updater.quitAndInstall();
	}

	private registerHandlers(): void {
		this.updater.on({
			onCheckingForUpdate: () => this.transition({ lifecycle: UpdateLifecycle.Checking }),
			onUpdateAvailable: (version) =>
				this.transition({ lifecycle: UpdateLifecycle.Available, version }),
			onUpdateNotAvailable: () => this.transition({ lifecycle: UpdateLifecycle.NotAvailable }),
			onDownloadProgress: (progress) =>
				this.transition({
					lifecycle: UpdateLifecycle.Downloading,
					...(this.state.version !== undefined ? { version: this.state.version } : {}),
					progress,
				}),
			onUpdateDownloaded: (version) =>
				this.transition({ lifecycle: UpdateLifecycle.Downloaded, version }),
			onError: (message) => this.transition({ lifecycle: UpdateLifecycle.Error, error: message }),
		});
	}

	private fail(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.transition({ lifecycle: UpdateLifecycle.Error, error: message });
	}

	private transition(next: AutoUpdateState): void {
		this.state = next;
		this.onState(next);
	}
}

/**
 * Renderer-safe wire-shape types for Feedback-1 (bug-report) and
 * Feedback-2 (crash reporter).
 *
 * Both `preload/index.ts` and renderer code (`renderer/feedback/feedback-dialog.tsx`,
 * `renderer/settings/network-egress-panel.tsx`, their tests) import from here,
 * so the renderer's value-import of `FeedbackKind` / `FeedbackSensitivity` /
 * `CrashKind` / `RendererReason` does NOT drag preload's `import { contextBridge,
 * ipcRenderer } from "electron"` into the renderer bundle (canonical trap;
 * same precedent as `sync-status-types.ts`).
 *
 * Main-process internals (`main/feedback/{feedback-payload,crash-payload}.ts`)
 * keep their own enum copies that match these wire values byte-for-byte; this
 * module is the renderer-facing wire-shape only.
 */

export enum FeedbackKind {
	Bug = "bug",
	Idea = "idea",
	Question = "question",
	Other = "other",
}

export enum FeedbackSensitivity {
	Anonymous = "anonymous",
	IdentityVoluntary = "identity-voluntary",
}

export type FeedbackPayload = {
	kind: FeedbackKind;
	title: string;
	body: string;
	sensitivity: FeedbackSensitivity;
	contactEmail?: string;
	includeRecentLog: boolean;
	recentLogExcerpt?: string;
	clientVersion: string;
	clientPlatform: string;
	submittedAt: number;
	requestId: string;
};

export type FeedbackSettings = {
	enabled: boolean;
	endpoint: string | null;
	installationId: string;
	crashReportingEnabled: boolean;
	lastCrashSubmitAttemptMs: number | null;
};

export type FeedbackSettingsPatch = {
	enabled?: boolean;
	endpoint?: string | null;
	crashReportingEnabled?: boolean;
};

export type FeedbackSubmitResult = {
	ok: true;
	requestId: string;
	serverReceivedAt: number;
};

export enum CrashKind {
	UncaughtException = "uncaught-exception",
	UnhandledRejection = "unhandled-rejection",
	RendererProcessGone = "renderer-process-gone",
	RendererCrashed = "renderer-crashed",
	RendererKilled = "renderer-killed",
	UnresponsiveRenderer = "unresponsive-renderer",
	MainProcessGone = "main-process-gone",
}

export enum RendererReason {
	Crashed = "crashed",
	Killed = "killed",
	OutOfMemory = "oom",
	LaunchFailed = "launch-failed",
	IntegrityFailure = "integrity-failure",
}

export type CrashPayload = {
	kind: CrashKind;
	rendererReason?: RendererReason;
	exitCode?: number;
	message: string;
	stack?: string;
	appId?: string;
	routePath?: string;
	recentLogExcerpt: string;
	clientVersion: string;
	clientPlatform: string;
	capturedAt: number;
	submittedAt?: number;
	requestId: string;
	installationId: string;
	durationSinceBootMs: number;
};

export type CrashPendingSummary = {
	count: number;
	localCount: number;
	lastCapturedAt: number | null;
	lastSubmitAttemptMs: number | null;
};

export type CrashSubmissionResult = {
	submitted: number;
	failed: number;
	dropped: number;
};

/**
 * Live preview panel — a docked, scaled-down glimpse of the running product
 * (a mini dashboard of app tiles + a sample app window) rendered under the
 * theme being edited. The app applies the edited token vars to this panel's
 * root element (`previewRef`), so the mockup inherits them and re-paints the
 * instant a token, font, or icon pack changes — while the surrounding editor
 * chrome keeps the shell's own theme.
 *
 * The app tiles are live: clicking one swaps the sample window to that app's
 * mockup. Token-driven only — the mockup must look right under any theme.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { type ReactElement, type Ref, useState } from "react";
import type { Translate } from "./translate";

enum PreviewApp {
	Notes = "notes",
	Tasks = "tasks",
	Files = "files",
	Calendar = "calendar",
	Settings = "settings",
}

type NavSpec = { icon: IconName; labelKey: string };

type PreviewAppSpec = {
	id: PreviewApp;
	icon: IconName;
	labelKey: string;
	nav: ReadonlyArray<NavSpec>;
	titleKey: string;
	bodyKey: string;
	actionKey: string;
	tagKey: string;
};

const PREVIEW_APPS: ReadonlyArray<PreviewAppSpec> = [
	{
		id: PreviewApp.Notes,
		icon: IconName.Pencil,
		labelKey: "preview.appNotes",
		nav: [
			{ icon: IconName.Inbox, labelKey: "preview.notes.nav1" },
			{ icon: IconName.Sparkle, labelKey: "preview.notes.nav2" },
			{ icon: IconName.Archive, labelKey: "preview.notes.nav3" },
		],
		titleKey: "preview.notes.title",
		bodyKey: "preview.notes.body",
		actionKey: "preview.notes.action",
		tagKey: "preview.notes.tag",
	},
	{
		id: PreviewApp.Tasks,
		icon: IconName.CheckCircle,
		labelKey: "preview.appTasks",
		nav: [
			{ icon: IconName.KindDate, labelKey: "preview.tasks.nav1" },
			{ icon: IconName.Inbox, labelKey: "preview.tasks.nav2" },
			{ icon: IconName.CheckCircle, labelKey: "preview.tasks.nav3" },
		],
		titleKey: "preview.tasks.title",
		bodyKey: "preview.tasks.body",
		actionKey: "preview.tasks.action",
		tagKey: "preview.tasks.tag",
	},
	{
		id: PreviewApp.Files,
		icon: IconName.Folder,
		labelKey: "preview.appFiles",
		nav: [
			{ icon: IconName.Inbox, labelKey: "preview.files.nav1" },
			{ icon: IconName.Sparkle, labelKey: "preview.files.nav2" },
			{ icon: IconName.Archive, labelKey: "preview.files.nav3" },
		],
		titleKey: "preview.files.title",
		bodyKey: "preview.files.body",
		actionKey: "preview.files.action",
		tagKey: "preview.files.tag",
	},
	{
		id: PreviewApp.Calendar,
		icon: IconName.KindDate,
		labelKey: "preview.appCalendar",
		nav: [
			{ icon: IconName.KindDate, labelKey: "preview.calendar.nav1" },
			{ icon: IconName.Inbox, labelKey: "preview.calendar.nav2" },
			{ icon: IconName.Archive, labelKey: "preview.calendar.nav3" },
		],
		titleKey: "preview.calendar.title",
		bodyKey: "preview.calendar.body",
		actionKey: "preview.calendar.action",
		tagKey: "preview.calendar.tag",
	},
	{
		id: PreviewApp.Settings,
		icon: IconName.Settings,
		labelKey: "preview.appSettings",
		nav: [
			{ icon: IconName.Settings, labelKey: "preview.settings.nav1" },
			{ icon: IconName.Sparkle, labelKey: "preview.settings.nav2" },
			{ icon: IconName.Archive, labelKey: "preview.settings.nav3" },
		],
		titleKey: "preview.settings.title",
		bodyKey: "preview.settings.body",
		actionKey: "preview.settings.action",
		tagKey: "preview.settings.tag",
	},
];

const DEFAULT_APP = PREVIEW_APPS[0] as PreviewAppSpec;

function specFor(id: PreviewApp): PreviewAppSpec {
	return PREVIEW_APPS.find((a) => a.id === id) ?? DEFAULT_APP;
}

function NavRow({
	t,
	spec,
	active,
}: { t: Translate; spec: NavSpec; active: boolean }): ReactElement {
	return (
		<div className={active ? "te-mini-nav__row te-mini-nav__row--active" : "te-mini-nav__row"}>
			<Icon name={spec.icon} size={14} />
			<span>{t(spec.labelKey)}</span>
		</div>
	);
}

/** The sample app window — header chrome, a nav sidebar, and a doc body that
 *  exercises title / body text / a primary button / a tag chip so the accent,
 *  surface, border, and text tokens all show at once. */
function SampleWindow({ t, app }: { t: Translate; app: PreviewAppSpec }): ReactElement {
	return (
		<div className="te-mini-window">
			<div className="te-mini-window__header">
				<div className="te-mini-window__dots">
					<span />
					<span />
					<span />
				</div>
				<div className="te-mini-window__titlebar">
					<Icon name={app.icon} size={13} />
					<span>{t(app.labelKey)}</span>
				</div>
			</div>
			<div className="te-mini-window__body">
				<div className="te-mini-nav">
					{app.nav.map((item, index) => (
						<NavRow key={item.labelKey} t={t} spec={item} active={index === 0} />
					))}
				</div>
				<div className="te-mini-doc">
					<h3 className="te-mini-doc__title">{t(app.titleKey)}</h3>
					<p className="te-mini-doc__body">{t(app.bodyKey)}</p>
					<div className="te-mini-doc__actions">
						<button
							type="button"
							className="bs-btn bs-btn--sm te-mini-doc__button"
							data-bs-primary
							tabIndex={-1}
						>
							<span>{t(app.actionKey)}</span>
						</button>
						<span className="te-mini-doc__tag">#{t(app.tagKey)}</span>
					</div>
				</div>
			</div>
		</div>
	);
}

export type PreviewPanelProps = {
	t: Translate;
	/** The element the app scopes the edited theme's CSS vars to. */
	previewRef: Ref<HTMLElement>;
};

export function PreviewPanel({ t, previewRef }: PreviewPanelProps): ReactElement {
	const [activeApp, setActiveApp] = useState<PreviewApp>(PreviewApp.Notes);

	return (
		<aside className="te-preview" aria-label={t("preview.label")} ref={previewRef}>
			<div className="te-preview__header">
				<h2 className="te-preview__title">{t("preview.label")}</h2>
			</div>
			<div className="te-preview__stage">
				<div className="te-mini-dash">
					{PREVIEW_APPS.map((spec) => {
						const active = spec.id === activeApp;
						return (
							<button
								key={spec.id}
								type="button"
								className={active ? "te-mini-tile te-mini-tile--active" : "te-mini-tile"}
								aria-pressed={active}
								onClick={() => setActiveApp(spec.id)}
							>
								<div className="te-mini-tile__face">
									<Icon name={spec.icon} size={18} />
								</div>
								<span className="te-mini-tile__label">{t(spec.labelKey)}</span>
							</button>
						);
					})}
				</div>
				<div className="te-preview__window-host">
					<SampleWindow t={t} app={specFor(activeApp)} />
				</div>
			</div>
			<p className="te-preview__caption">{t("preview.caption")}</p>
		</aside>
	);
}

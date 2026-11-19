/**
 * Welcome-2 (9.3.5.V 7d) — first-launch template gallery. Browses the bundled
 * vault templates (`window.brainstorm.welcome.listTemplates`) and lets the user
 * pick one to import after the vault is created. Single-select with toggle-off:
 * clicking the selected card clears the choice (back to "blank"), so the gallery
 * itself expresses both "start from a template" and "start blank".
 *
 * Template `name` / `description` are bundled-content strings from the main-side
 * registry (rendered as data, like a vault name); only the gallery chrome is
 * `t()`-localised.
 */

import type { WelcomeTemplateSummary } from "../../preload";
import { t } from "../i18n/t";
import { Icon, IconName } from "../ui/icon";

/** Glyph per bundled template, keyed by the registry's stable id (the ids never
 *  change — see `template-registry.ts`). Anything unmapped falls back to the
 *  generic "new collection" glyph, so adding a template never breaks the tile. */
const TEMPLATE_ICONS: Record<string, IconName> = {
	"project-management": IconName.Tasks,
	"small-business": IconName.Storefront,
	research: IconName.Search,
	study: IconName.Book,
	"personal-knowledge": IconName.Sparkle,
	writing: IconName.Pencil,
	journaling: IconName.Calendar,
};

type TemplateGalleryProps = {
	readonly templates: ReadonlyArray<WelcomeTemplateSummary>;
	readonly selectedId: string | null;
	readonly onSelect: (id: string | null) => void;
	readonly disabled?: boolean;
};

export function TemplateGallery({
	templates,
	selectedId,
	onSelect,
	disabled = false,
}: TemplateGalleryProps) {
	if (templates.length === 0) return null;
	return (
		<section className="welcome__templates" aria-labelledby="welcome-templates-heading">
			<h2 className="welcome__templates-heading" id="welcome-templates-heading">
				{t("shell.welcome.templates.heading")}
			</h2>
			<p className="welcome__hint">{t("shell.welcome.templates.hint")}</p>
			<ul className="welcome__templates-grid" data-testid="welcome-templates">
				{templates.map((template) => {
					const selected = template.id === selectedId;
					return (
						<li key={template.id}>
							<button
								type="button"
								className={
									selected
										? "welcome__template-card welcome__template-card--selected"
										: "welcome__template-card"
								}
								aria-pressed={selected}
								disabled={disabled}
								onClick={() => onSelect(selected ? null : template.id)}
								data-testid={`welcome-template-${template.id}`}
								title={template.description}
							>
								<span className="welcome__template-icon" aria-hidden="true">
									<Icon name={TEMPLATE_ICONS[template.id] ?? IconName.FolderPlus} size={22} />
								</span>
								<span className="welcome__template-name">{template.name}</span>
								<span className="welcome__template-desc">{template.description}</span>
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

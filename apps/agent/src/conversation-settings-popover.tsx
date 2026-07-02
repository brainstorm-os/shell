/**
 * Agent-5 — the per-conversation settings dialog: tool grants (narrowing only),
 * the model/provider picker, and the token budget. Built on the shared
 * `@brainstorm/sdk/popover` + `@brainstorm/sdk/select-menu` primitives (no
 * bespoke chrome). Pure presentation over the pure helpers in
 * `logic/conversation-settings.ts`; the parent owns persistence.
 *
 * SECURITY: every change only NARROWS — `composeGrants` filters the enabled set
 * to caps the app holds, and the provider picker offers only the app's granted
 * `ai.provider:<id>`s. The three-tier intersection remains the chokepoint.
 */

import { Checkbox } from "@brainstorm/sdk/checkbox";
import { Popover, PopoverSize } from "@brainstorm/sdk/popover";
import { SelectMenu } from "@brainstorm/sdk/select-menu";
import type { SelectMenuOption } from "@brainstorm/sdk/select-menu";
import { useMemo } from "react";
import type { ReactElement } from "react";
import { type AgentI18nKey, t } from "./i18n";
import {
	AUTO_PROVIDER,
	composeGrants,
	enabledToggleableGrants,
	grantVerb,
	grantedProviderIds,
	providerForRequest,
	resolveProvider,
	toggleableAppCaps,
} from "./logic/conversation-settings";

/** The provider id → its catalog label key. Unknown ids fall back to the id
 *  itself (a forward-compat provider the app gained a cap for but the catalog
 *  hasn't named yet). */
const PROVIDER_LABEL_KEY: Record<string, AgentI18nKey> = {
	ollama: "provider.ollama",
	anthropic: "provider.anthropic",
	openai: "provider.openai",
	glm: "provider.glm",
	mistral: "provider.mistral",
	gemini: "provider.gemini",
};

/** The intent verb → its catalog label key for the grants toggles. */
const VERB_LABEL_KEY: Record<string, AgentI18nKey> = {
	open: "tool.verb.open",
	create: "tool.verb.create",
	update: "tool.verb.update",
	delete: "tool.verb.delete",
};

export function providerLabel(id: string): string {
	const key = PROVIDER_LABEL_KEY[id];
	return key ? t(key) : id;
}

export function grantLabel(cap: string): string {
	const verb = grantVerb(cap);
	const key = VERB_LABEL_KEY[verb];
	return key ? t(key) : verb;
}

export type ConversationSettings = {
	grants: readonly string[];
	provider: string | undefined;
	model: string | undefined;
	tokenBudget: number | undefined;
	tokensSpent: number;
};

export type ConversationSettingsPopoverProps = {
	appCaps: readonly string[];
	settings: ConversationSettings;
	onClose: () => void;
	/** Persist a narrowed grant set (already composed from the enabled toggles). */
	onGrantsChange: (grants: string[]) => void;
	/** Persist the pinned provider (`undefined` = AUTO / shell default). */
	onProviderChange: (provider: string | undefined) => void;
	/** Persist the token budget (`undefined` = no limit). */
	onBudgetChange: (tokenBudget: number | undefined) => void;
};

export function ConversationSettingsPopover({
	appCaps,
	settings,
	onClose,
	onGrantsChange,
	onProviderChange,
	onBudgetChange,
}: ConversationSettingsPopoverProps): ReactElement {
	const toggleable = useMemo(() => toggleableAppCaps(appCaps), [appCaps]);
	const enabled = useMemo(
		() => new Set(enabledToggleableGrants(appCaps, settings.grants)),
		[appCaps, settings.grants],
	);

	const providerOptions = useMemo<SelectMenuOption[]>(() => {
		const auto: SelectMenuOption = { value: AUTO_PROVIDER, label: t("settings.model.auto") };
		const rest = grantedProviderIds(appCaps).map((id) => ({ value: id, label: providerLabel(id) }));
		return [auto, ...rest];
	}, [appCaps]);
	const resolvedProvider = resolveProvider(appCaps, settings.provider);

	const onToggle = (cap: string, next: boolean) => {
		const nextEnabled = new Set(enabled);
		if (next) nextEnabled.add(cap);
		else nextEnabled.delete(cap);
		onGrantsChange(composeGrants(appCaps, [...nextEnabled]));
	};

	const onBudgetInput = (raw: string) => {
		const trimmed = raw.trim();
		if (trimmed === "") {
			onBudgetChange(undefined);
			return;
		}
		const n = Math.floor(Number(trimmed));
		if (!Number.isFinite(n) || n <= 0) {
			onBudgetChange(undefined);
			return;
		}
		onBudgetChange(n);
	};

	const spentLabel =
		settings.tokenBudget !== undefined
			? t("settings.budget.spent", {
					spent: String(settings.tokensSpent),
					budget: String(settings.tokenBudget),
				})
			: t("settings.budget.spentNoLimit", { spent: String(settings.tokensSpent) });

	return (
		<Popover
			title={t("settings.title")}
			onClose={onClose}
			size={PopoverSize.Medium}
			testId="agent-settings"
		>
			<div className="agent-settings">
				<section className="agent-settings__section">
					<h3 className="agent-settings__heading">{t("settings.model.heading")}</h3>
					<p className="agent-settings__blurb">{t("settings.model.blurb")}</p>
					<div className="agent-settings__field">
						<span className="agent-settings__field-label">{t("settings.model.label")}</span>
						<SelectMenu
							value={resolvedProvider}
							options={providerOptions}
							ariaLabel={t("settings.model.label")}
							onChange={(next) => onProviderChange(providerForRequest(next))}
							data-testid="agent-settings-provider"
						/>
					</div>
				</section>

				<section className="agent-settings__section">
					<h3 className="agent-settings__heading">{t("settings.tools.heading")}</h3>
					<p className="agent-settings__blurb">{t("settings.tools.blurb")}</p>
					{toggleable.length === 0 ? (
						<p className="agent-settings__empty">{t("settings.tools.none")}</p>
					) : (
						<ul className="agent-settings__tools">
							{toggleable.map((cap) => (
								<li key={cap} className="agent-settings__tool">
									<Checkbox
										label={t("settings.tools.toggle", { tool: grantLabel(cap) })}
										checked={enabled.has(cap)}
										onChange={(next) => onToggle(cap, next)}
										testId={`agent-settings-grant-${grantVerb(cap)}`}
									/>
								</li>
							))}
						</ul>
					)}
				</section>

				<section className="agent-settings__section">
					<h3 className="agent-settings__heading">{t("settings.budget.heading")}</h3>
					<p className="agent-settings__blurb">{t("settings.budget.blurb")}</p>
					<label className="agent-settings__field">
						<span className="agent-settings__field-label">{t("settings.budget.label")}</span>
						<input
							type="number"
							min={0}
							step={100}
							className="bs-input"
							defaultValue={settings.tokenBudget ?? ""}
							placeholder={t("settings.budget.placeholder")}
							onChange={(e) => onBudgetInput(e.target.value)}
							aria-label={t("settings.budget.label")}
							data-testid="agent-settings-budget"
						/>
					</label>
					<p className="agent-settings__spent">{spentLabel}</p>
				</section>
			</div>
		</Popover>
	);
}

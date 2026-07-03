/**
 * Agent app i18n manifest. Per
 * §Localization every user-visible string flows through the shared app-side
 * `t()` (`createT` from `@brainstorm/sdk/i18n`) — no bare literals.
 */

import { type TParams, createT, plural as sdkPlural } from "@brainstorm/sdk/i18n";

export const AGENT_I18N = {
	"app.title": "Agent",
	"header.newChat": "New chat",
	"header.moreActions": "More actions",
	"header.sidebar.show": "Show conversations",
	"header.sidebar.hide": "Hide conversations",
	"sidebar.conversations": "Conversations",
	"sidebar.empty": "No conversations yet.",
	"chat.empty.title": "Ask the agent anything",
	"chat.empty.blurb": "Chat runs on your local model. Your messages stay on this device.",
	"chat.placeholder": "Message the agent…",
	"chat.send": "Send",
	"chat.thinking": "Thinking…",
	"chat.untitled": "New conversation",
	"composer.attach.button": "Add context",
	"composer.attach.mention": "Mention or link a document or person",
	"composer.attach.upload": "Upload media…",
	"composer.attach.search": "Mention a document or person",
	"composer.attach.empty": "No matches",
	"composer.attach.remove": "Remove {label}",
	"composer.attach.open": "Open {label}",
	"composer.attach.uploadFailed": "Couldn't attach that file.",
	"composer.attach.tooLarge": "That file is too large to attach (25 MB max).",
	"role.you": "You",
	"role.assistant": "Agent",
	"tool.open.label": "Open or navigate to an object in your vault by its id",
	"tool.used": "Used {tool}",
	"tool.verb.open": "Open objects",
	"tool.verb.create": "Create objects",
	"tool.verb.update": "Update objects",
	"tool.verb.delete": "Delete objects",
	"citations.label": "Sources",
	"citations.open": "Open {title}",
	"header.settings": "Conversation settings",
	"settings.title": "Conversation settings",
	"settings.done": "Done",
	"settings.tools.heading": "Tools",
	"settings.tools.blurb":
		"Choose which actions the agent may take in this conversation. Turning one off only narrows what it can do here — it can never grant more than the app already has.",
	"settings.tools.none": "This app exposes no optional tools.",
	"settings.tools.toggle": "Allow “{tool}”",
	"settings.model.heading": "Model",
	"settings.model.blurb": "Pick the AI provider for this conversation.",
	"settings.model.label": "Provider",
	"settings.model.auto": "Automatic (recommended)",
	"settings.budget.heading": "Token budget",
	"settings.budget.blurb":
		"Stop the conversation once it has used about this many prompt tokens. Leave blank for no limit.",
	"settings.budget.label": "Prompt-token budget",
	"settings.budget.placeholder": "No limit",
	"settings.budget.spent": "{spent} of {budget} prompt tokens used",
	"settings.budget.spentNoLimit": "{spent} prompt tokens used",
	"provider.ollama": "Local model (Ollama)",
	"provider.anthropic": "Anthropic Claude",
	"provider.openai": "OpenAI-compatible",
	"provider.glm": "z.ai GLM",
	"provider.mistral": "Mistral AI",
	"provider.gemini": "Google Gemini",
	"error.budget":
		"This conversation has reached its token budget. Raise or clear the budget in conversation settings to continue.",
	"escalation.title": "Allow “{tool}”?",
	"escalation.blurb":
		"The agent tried to use a tool that isn’t enabled for this conversation. Allow it for this conversation only?",
	"escalation.allow": "Allow for this conversation",
	"escalation.dismiss": "Not now",
	"header.memory": "Memory",
	"memory.title": "Long-term memory",
	"memory.blurb":
		"Off by default. When on, the agent can remember salient facts you choose and recall them in future conversations. Nothing is stored without your action, and you can edit or delete anything here.",
	"memory.enable": "Let the agent remember facts across conversations",
	"memory.list.heading": "Stored memories",
	"memory.list.empty": "No memories stored yet.",
	"memory.edit.label": "Edit memory",
	"memory.delete": "Delete memory",
	"memory.clearAll": "Clear all",
	"memory.remember": "Remember",
	"memory.remember.hint": "Save a fact from this reply for the agent to recall later",
	"header.saveAutomation": "Save as automation",
	"saveAuto.title": "Save as automation",
	"saveAuto.blurb":
		"Review the automation distilled from this conversation. It re-runs the agent with the same tools on a new input. Nothing is created until you save.",
	"saveAuto.name.heading": "Name",
	"saveAuto.name.untitled": "Untitled automation",
	"saveAuto.trigger.heading": "Trigger",
	"saveAuto.trigger.manual": "Run manually (Run now).",
	"saveAuto.step.heading": "What it does",
	"saveAuto.params.heading": "Inputs",
	"saveAuto.params.blurb":
		"Run-specific values are replaced with the trigger’s input so the automation is reusable.",
	"saveAuto.params.example": "e.g. {value}",
	"saveAuto.caps.heading": "Permissions",
	"saveAuto.caps.blurb":
		"The automation can only use the permissions this conversation was granted — never more.",
	"saveAuto.cancel": "Cancel",
	"saveAuto.confirm": "Save automation",
	"saveAuto.saving": "Saving…",
	"saveAuto.noTools":
		"This conversation hasn’t used any tools yet, so there’s nothing to turn into an automation.",
	"saveAuto.saved": "Saved as an automation.",
	"saveAuto.error": "Couldn’t save this conversation as an automation.",
	"error.unavailable":
		"The local AI model is unavailable. Is Ollama running? Start it with `ollama serve` and pull a model (e.g. `ollama pull llama3.2`).",
	"error.unavailable.cloud":
		"Couldn’t reach {provider}. Check that its API key is set in Settings → AI, or pick another provider in conversation settings.",
	"error.unavailable.auto":
		"No AI model could be reached. Pick a provider for this conversation in settings, or set one up in Settings → AI.",
	"error.capability":
		"The Agent app is missing AI access — restart the shell so it reinstalls with the `ai.use` capability granted.",
	"error.generic": "Something went wrong generating a reply.",
	"provenance.via": "via {model}",

	"widget.label": "Agent",
	"widget.count.one": "{count} conversation",
	"widget.count.other": "{count} conversations",
	"widget.empty": "No conversations yet",
	"widget.empty.action": "Ask the Agent",
	"widget.updated": "Updated {date}",
	"widget.date.today": "today",
	"widget.date.tomorrow": "tomorrow",
	"widget.date.yesterday": "yesterday",
} as const;

export type AgentI18nKey = keyof typeof AGENT_I18N;

export const t = createT(AGENT_I18N);

/** Catalog-bound plural — picks `<base>.one` / `<base>.other`. The count
 *  selection lives in the shared helper, not in component code. */
export const plural = (
	count: number,
	oneKey: AgentI18nKey,
	otherKey: AgentI18nKey,
	params?: TParams,
): string => sdkPlural(t, count, oneKey, otherKey, params);

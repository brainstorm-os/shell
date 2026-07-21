/**
 * Shared "coming soon" placeholder surface — the single render path every
 * not-yet-built stub app uses for its window body. Scaffolding the unbuilt
 * first-party apps (Theme Editor, Books, Contacts, Form Designer,
 * Automations, Mailbox, Web Browser, Agent) registers each as a real,
 * launchable app whose UI is this one primitive — NOT 8 hand-rolled copies
 * of the same boot+render code ([[extract-to-sdk-at-copy-two]]). When an
 * app's real build lands, its `app.ts` stops calling this and renders the
 * feature instead.
 *
 * All user-visible strings are passed in (the caller resolves them through
 * its own `t()` i18n manifest), so this primitive ships no bare literals.
 */

export type ComingSoonLabels = {
	/** Small eyebrow above the title, e.g. the localized "Coming soon". */
	badge: string;
	/** The app's display name. */
	title: string;
	/** One or two sentences describing what the app will do. */
	blurb: string;
};

/**
 * Render the placeholder into `root`, replacing any existing content. Uses
 * `textContent` for every string so a translated label can never inject
 * markup. Styling comes from `@brainstorm-os/sdk/coming-soon/coming-soon.css`
 * (the caller imports it once); this helper only builds the DOM.
 */
export function mountComingSoon(root: HTMLElement, labels: ComingSoonLabels): void {
	root.replaceChildren();

	const card = document.createElement("section");
	card.className = "bs-coming-soon";

	const badge = document.createElement("p");
	badge.className = "bs-coming-soon__badge";
	badge.textContent = labels.badge;

	const title = document.createElement("h1");
	title.className = "bs-coming-soon__title";
	title.textContent = labels.title;

	const blurb = document.createElement("p");
	blurb.className = "bs-coming-soon__blurb";
	blurb.textContent = labels.blurb;

	card.append(badge, title, blurb);
	root.append(card);
}

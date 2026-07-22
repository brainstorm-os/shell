import { AnalyticsErrorScope, trackError } from "@brainstorm-os/sdk/analytics";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { CloudSyncWarning, WelcomeTemplateSummary } from "../../preload";
import { classifyVaultError } from "../analytics/classify-vault-error";
import { t } from "../i18n/t";
import { BrandMark } from "../ui/brand-mark";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { IconName } from "../ui/icon";
import { TextField, TextFieldSize } from "../ui/text-field";
import { ToastKind, pushToast } from "../ui/toasts";
import { useVault } from "../vault-context";
import { JoinVaultEntry } from "./join-vault-entry";
import { MigrateEntry } from "./migrate-entry";
import { requestMigrationImport } from "./migration-intent";
import { TemplateGallery } from "./template-gallery";
import { WelcomeTile } from "./welcome-tile";
import "./welcome.css";

enum WelcomeMode {
	Menu = "menu",
	Create = "create",
	Start = "start",
	Opening = "opening",
}

/** A new vault's name collides with an existing one (case- and
 *  whitespace-insensitive). Surfaced inline on the create form so the user
 *  fixes it before submitting rather than hitting a path-collision error. */
export function isVaultNameTaken(vaults: ReadonlyArray<{ name: string }>, name: string): boolean {
	const normalized = name.trim().toLowerCase();
	if (!normalized) return false;
	return vaults.some((vault) => vault.name.trim().toLowerCase() === normalized);
}

export function Welcome() {
	const { allVaults, create, openByPath, pickFolder, defaultPath, checkPath, activate } = useVault();
	const [mode, setMode] = useState<WelcomeMode>(WelcomeMode.Menu);
	// Starts empty on purpose: pre-filling a name ("Personal") surfaced the
	// duplicate-name error before the user typed anything when such a vault
	// already existed. The suggestion lives in the placeholder instead.
	const [name, setName] = useState("");
	const [path, setPath] = useState("");
	const [cloudWarning, setCloudWarning] = useState<CloudSyncWarning | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [addStarterContent, setAddStarterContent] = useState(true);
	// The user entered the create flow via "Migrating from…": on a successful
	// create, hand the dashboard a one-shot to open Backup & Migration (IE-3).
	const [migrating, setMigrating] = useState(false);
	const [templates, setTemplates] = useState<ReadonlyArray<WelcomeTemplateSummary>>([]);
	const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

	// Load the bundled template gallery once. Best-effort: a failure (or a host
	// without the welcome bridge) just leaves the gallery empty — it renders
	// nothing, so the create form still works.
	useEffect(() => {
		const api = window.brainstorm?.welcome;
		if (!api) return;
		let cancelled = false;
		void api
			.listTemplates()
			.then((list) => {
				if (!cancelled) setTemplates(list);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	// KBN-S-welcome (12.4): move focus on each step transition — into the
	// create form's first field when entering it, back to the opener CTA when
	// returning to the menu (never on the initial mount, so first launch
	// doesn't yank focus). The final "opening" step unmounts Welcome and the
	// dashboard takes focus.
	const createCtaRef = useRef<HTMLButtonElement>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const nameFieldId = useId();
	const pathFieldId = useId();
	const startHeadingRef = useRef<HTMLHeadingElement>(null);
	const prevModeRef = useRef<WelcomeMode>(mode);
	useEffect(() => {
		const prev = prevModeRef.current;
		prevModeRef.current = mode;
		if (mode === WelcomeMode.Create) nameInputRef.current?.focus();
		else if (mode === WelcomeMode.Start) startHeadingRef.current?.focus();
		else if (mode === WelcomeMode.Menu && prev === WelcomeMode.Create) createCtaRef.current?.focus();
	}, [mode]);

	useEffect(() => {
		void defaultPath(name).then(setPath);
	}, [name, defaultPath]);

	const trimmedName = name.trim();
	const nameTaken = isVaultNameTaken(allVaults, name);

	useEffect(() => {
		if (!path) {
			setCloudWarning(null);
			return;
		}
		let cancelled = false;
		void checkPath(path).then((warning) => {
			if (!cancelled) setCloudWarning(warning);
		});
		return () => {
			cancelled = true;
		};
	}, [path, checkPath]);

	async function handleChooseFolder() {
		const chosen = await pickFolder("create");
		if (chosen) setPath(chosen);
	}

	// Step 1 → step 2. The name/location validation lives here so step 2 can
	// assume a valid vault target (it has no name/location inputs).
	function goToStart(event: FormEvent) {
		event.preventDefault();
		if (nameTaken || !trimmedName || !path) return;
		setError(null);
		setMode(WelcomeMode.Start);
	}

	async function doCreate(templateId: string | null, seedStarterContent: boolean) {
		if (nameTaken || !trimmedName || !path) return;
		setError(null);
		setBusy(true);
		try {
			// A chosen template supersedes the generic example seed — it merges its
			// own richer content under a removable parent Collection. The import runs
			// after `create` resolves, by which point the new vault's session is
			// active (vault-context activates + refreshes before returning).
			await create({ name: name.trim(), path, seedStarterContent });
			// Vault is created + active here; hand the dashboard the one-shot so it
			// opens Backup & Migration the moment Welcome unmounts (IE-3).
			if (migrating) requestMigrationImport();
			if (templateId) {
				const result = await window.brainstorm.welcome.importTemplate(templateId);
				if (!result.ok) {
					trackError(AnalyticsErrorScope.TemplateImport, "import_failed");
					pushToast({
						kind: ToastKind.Error,
						title: t("shell.welcome.templates.importFailedTitle"),
						body: t("shell.welcome.templates.importFailedBody"),
					});
				}
			}
		} catch (e) {
			trackError(AnalyticsErrorScope.VaultCreate, classifyVaultError(e));
			setError(e instanceof Error ? e.message : t("shell.welcome.createFailed"));
		} finally {
			setBusy(false);
		}
	}

	// Step 2 primary: create with the current starting-point selection.
	function handleCreate(event: FormEvent) {
		event.preventDefault();
		void doCreate(selectedTemplateId, selectedTemplateId ? false : addStarterContent);
	}

	// Step 2 "Skip": start with an empty vault — no template, no example content.
	function handleSkip() {
		void doCreate(null, false);
	}

	async function handleOpen() {
		setError(null);
		const chosen = await pickFolder("open");
		if (!chosen) return;
		setMode(WelcomeMode.Opening);
		setBusy(true);
		try {
			await openByPath(chosen);
		} catch (e) {
			trackError(AnalyticsErrorScope.VaultOpen, classifyVaultError(e));
			setError(e instanceof Error ? e.message : t("shell.welcome.openFailed"));
			setMode(WelcomeMode.Menu);
		} finally {
			setBusy(false);
		}
	}

	return (
		<main className="welcome">
			<div className="welcome__title-bar" />
			<div
				className={
					mode === WelcomeMode.Create || mode === WelcomeMode.Start
						? "welcome__content welcome__content--wide"
						: "welcome__content"
				}
			>
				<div className="welcome__brand">
					<BrandMark size={104} className="welcome__mark" />
					<h1 className="welcome__title">{t("shell.welcome.brand")}</h1>
				</div>
				<p className="welcome__tagline">{t("shell.welcome.tagline")}</p>

				{mode === WelcomeMode.Menu && (
					<div className="welcome__menu">
						<div className="welcome__tiles">
							<WelcomeTile
								ref={createCtaRef}
								icon={IconName.Plus}
								label={t("shell.welcome.createCta")}
								primary
								onClick={() => setMode(WelcomeMode.Create)}
								disabled={busy}
								testId="welcome-create-cta"
							/>
							<WelcomeTile
								icon={IconName.Folder}
								label={t("shell.welcome.openCta")}
								onClick={handleOpen}
								disabled={busy}
								testId="welcome-open-cta"
							/>
							{/* Reachable before any vault exists — pairing a brand-new device
							    is a first-run path (see join-vault-entry.tsx). */}
							<JoinVaultEntry disabled={busy} />
							<MigrateEntry
								disabled={busy}
								onStart={() => {
									setMigrating(true);
									setMode(WelcomeMode.Create);
								}}
							/>
						</div>
						{allVaults.length > 0 && (
							<section className="welcome__recent">
								<h2 className="welcome__recent-title">{t("shell.welcome.recentTitle")}</h2>
								<ul className="welcome__recent-list">
									{allVaults.map((vault) => (
										<li key={vault.id}>
											<button
												type="button"
												className="welcome__recent-item"
												onClick={() => activate(vault.id)}
												disabled={busy}
											>
												<span
													className="welcome__recent-dot"
													style={{ background: vault.color }}
													aria-hidden="true"
												/>
												<span className="welcome__recent-name">{vault.name}</span>
												<span className="welcome__recent-path">{vault.path}</span>
											</button>
										</li>
									))}
								</ul>
							</section>
						)}
					</div>
				)}

				{mode === WelcomeMode.Create && (
					<form className="welcome__form" onSubmit={goToStart}>
						<div className="welcome__field">
							<label className="welcome__label" htmlFor={nameFieldId}>
								{t("shell.welcome.nameLabel")}
							</label>
							<TextField
								id={nameFieldId}
								ref={nameInputRef}
								size={TextFieldSize.Lg}
								type="text"
								value={name}
								onChange={setName}
								placeholder={t("shell.welcome.namePlaceholder")}
								disabled={busy}
								{...(nameTaken
									? {
											error: (
												<span role="alert" data-testid="welcome-name-error">
													{t("shell.welcome.nameTaken", { name: trimmedName })}
												</span>
											),
										}
									: {})}
							/>
						</div>
						<div className="welcome__field">
							<label className="welcome__label" htmlFor={pathFieldId}>
								{t("shell.welcome.locationLabel")}
							</label>
							<div className="welcome__path-row">
								<TextField
									id={pathFieldId}
									size={TextFieldSize.Lg}
									type="text"
									value={path}
									onChange={setPath}
									disabled={busy}
								/>
								<Button
									variant={ButtonVariant.Neutral}
									size={ButtonSize.Lg}
									onClick={handleChooseFolder}
									disabled={busy}
								>
									{t("shell.welcome.chooseFolder")}
								</Button>
							</div>
						</div>
						{cloudWarning && (
							<div className="welcome__cloud-warning" role="alert" data-testid="welcome-cloud-warning">
								<strong>
									{t("shell.welcome.cloudWarning.title", { service: cloudWarning.displayName })}
								</strong>
								<span>
									{cloudWarning.hint} {t("shell.welcome.cloudWarning.hint")}
								</span>
							</div>
						)}
						<p className="welcome__hint">{t("shell.welcome.vaultHint")}</p>
						<div className="welcome__actions">
							<Button
								variant={ButtonVariant.Neutral}
								size={ButtonSize.Lg}
								onClick={() => {
									setMigrating(false);
									setMode(WelcomeMode.Menu);
								}}
								disabled={busy}
							>
								{t("shell.welcome.back")}
							</Button>
							<Button
								type="submit"
								variant={ButtonVariant.Primary}
								size={ButtonSize.Lg}
								disabled={!trimmedName || !path || nameTaken}
							>
								{t("shell.welcome.continue")}
							</Button>
						</div>
					</form>
				)}

				{mode === WelcomeMode.Start && (
					<form className="welcome__form" onSubmit={handleCreate}>
						<div className="welcome__step-head">
							<h2 className="welcome__step-title" ref={startHeadingRef} tabIndex={-1}>
								{t("shell.welcome.startStepTitle")}
							</h2>
							<p className="welcome__hint">{t("shell.welcome.startStepSubtitle")}</p>
						</div>
						<div className="welcome__starter">
							<Checkbox
								checked={selectedTemplateId ? false : addStarterContent}
								onChange={setAddStarterContent}
								disabled={busy || selectedTemplateId !== null}
								label={t("shell.welcome.starterContentLabel")}
								describedById="welcome-starter-content-hint"
								data-testid="welcome-starter-content"
							/>
							<p id="welcome-starter-content-hint" className="welcome__hint welcome__hint--sub">
								{selectedTemplateId
									? t("shell.welcome.starterContentTemplateHint")
									: t("shell.welcome.starterContentHint")}
							</p>
						</div>
						<TemplateGallery
							templates={templates}
							selectedId={selectedTemplateId}
							onSelect={setSelectedTemplateId}
							disabled={busy}
						/>
						<div className="welcome__actions">
							<Button
								variant={ButtonVariant.Neutral}
								size={ButtonSize.Lg}
								onClick={() => setMode(WelcomeMode.Create)}
								disabled={busy}
							>
								{t("shell.welcome.back")}
							</Button>
							<Button
								variant={ButtonVariant.Neutral}
								size={ButtonSize.Lg}
								onClick={handleSkip}
								disabled={busy}
							>
								{t("shell.welcome.skip")}
							</Button>
							<Button
								type="submit"
								variant={ButtonVariant.Primary}
								size={ButtonSize.Lg}
								loading={busy}
								disabled={!trimmedName || !path || nameTaken}
							>
								{t("shell.welcome.createVault")}
							</Button>
						</div>
					</form>
				)}

				{error && <p className="welcome__error">{error}</p>}
			</div>
		</main>
	);
}

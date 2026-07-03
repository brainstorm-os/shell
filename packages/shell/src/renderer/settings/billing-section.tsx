/**
 * Settings → Billing (14.6) — the real account/billing state, next to the
 * visual-only Membership pricing surface.
 *
 * Three groups:
 *   - Plan: the effective entitlement the shell holds (BillingService via
 *     the privileged bridge) + plan-derived quota lines + local storage use.
 *   - Account: link/unlink the billing-edge refresh credential, live
 *     summary (billing status), portal + Stripe-Checkout deep links. The
 *     portal owns payment — checkout/manage URLs open EXTERNALLY through
 *     the intent OS-handoff chokepoint (same as the updates download page);
 *     Stripe never renders in-product.
 *   - Invoices: billing-edge `/v1/account/invoices` (linked accounts only),
 *     each row deep-linking to Stripe's hosted invoice page.
 *
 * Everything is fail-soft: signed-out, offline, and revoked-credential all
 * render explanatory lines, never a crash. Network I/O happens in the main
 * process (`BillingAccountService`); this panel only invokes the bridge.
 */

import { useCallback, useEffect, useId, useState } from "react";
import {
	BillingAccountStatus,
	type BillingAccountSummaryView,
	BillingCheckoutCycle,
	BillingCheckoutPlan,
	type BillingInvoiceView,
	type BillingOverviewView,
	BillingSettingsFailure,
} from "../../shared/billing-settings-types";
import { EntitlementStatus, FeatureFlag, PlanTier } from "../../shared/billing-types";
import { formatBytes } from "../format/relative-time";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { ConfirmVariant, confirm } from "../ui/confirm";
import { IconName } from "../ui/icon";
import { SettingRow, SettingSelect } from "./settings-controls";
import "./billing-section.css";

const PLAN_LABEL_KEYS: Record<PlanTier, string> = {
	[PlanTier.Free]: "shell.settings.billing.plan.free",
	[PlanTier.Plus]: "shell.settings.billing.plan.plus",
	[PlanTier.Pro]: "shell.settings.billing.plan.pro",
	[PlanTier.Team]: "shell.settings.billing.plan.team",
	[PlanTier.Enterprise]: "shell.settings.billing.plan.enterprise",
};

/** Display mirror of the control plane's per-plan storage quotas
 *  (`brainstorm-cloud` billing-edge §metering `quota_for`) — presentation
 *  only; enforcement stays server-side (14.7). */
const PLAN_STORAGE_KEYS: Record<PlanTier, string> = {
	[PlanTier.Free]: "shell.settings.billing.quota.storage.free",
	[PlanTier.Plus]: "shell.settings.billing.quota.storage.plus",
	[PlanTier.Pro]: "shell.settings.billing.quota.storage.pro",
	[PlanTier.Team]: "shell.settings.billing.quota.storage.team",
	[PlanTier.Enterprise]: "shell.settings.billing.quota.storage.enterprise",
};

const ENTITLEMENT_STATUS_KEYS: Record<EntitlementStatus, string> = {
	[EntitlementStatus.Active]: "shell.settings.billing.entitlement.active",
	[EntitlementStatus.Grace]: "shell.settings.billing.entitlement.grace",
};

const ACCOUNT_STATUS_KEYS: Record<BillingAccountStatus, string> = {
	[BillingAccountStatus.Active]: "shell.settings.billing.accountStatus.active",
	[BillingAccountStatus.PastDue]: "shell.settings.billing.accountStatus.pastDue",
	[BillingAccountStatus.Disputed]: "shell.settings.billing.accountStatus.disputed",
	[BillingAccountStatus.Suspended]: "shell.settings.billing.accountStatus.suspended",
};

const FEATURE_LABEL_KEYS: Record<FeatureFlag, string> = {
	[FeatureFlag.HostedRelay]: "shell.settings.billing.feature.hostedRelay",
	[FeatureFlag.EncryptedBackup]: "shell.settings.billing.feature.encryptedBackup",
	[FeatureFlag.LargeAttachments]: "shell.settings.billing.feature.largeAttachments",
	[FeatureFlag.BundledAiCredits]: "shell.settings.billing.feature.bundledAiCredits",
};

const FAILURE_MESSAGE_KEYS: Record<BillingSettingsFailure, string> = {
	[BillingSettingsFailure.Unavailable]: "shell.settings.billing.error.unavailable",
	[BillingSettingsFailure.NotLinked]: "shell.settings.billing.error.notLinked",
	[BillingSettingsFailure.Offline]: "shell.settings.billing.error.offline",
	[BillingSettingsFailure.Unauthorized]: "shell.settings.billing.error.unauthorized",
	[BillingSettingsFailure.Service]: "shell.settings.billing.error.service",
	[BillingSettingsFailure.Invalid]: "shell.settings.billing.error.invalid",
};

export function failureMessage(reason: BillingSettingsFailure): string {
	return t(FAILURE_MESSAGE_KEYS[reason]);
}

export function formatInvoiceAmount(invoice: BillingInvoiceView): string {
	const units = invoice.amountPaidCents / 100;
	try {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency: invoice.currency.toUpperCase(),
		}).format(units);
	} catch {
		return `${units.toFixed(2)} ${invoice.currency.toUpperCase()}`;
	}
}

export function formatInvoiceDate(createdMs: number): string {
	const date = new Date(createdMs);
	if (Number.isNaN(date.getTime())) return "—";
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

/** Open an external URL through the intent OS-handoff chokepoint (the same
 *  path the updates panel uses for the download page). */
function openExternalUrl(url: string): void {
	void window.brainstorm?.intents?.dispatch({ verb: "open", payload: { url } });
}

/** The effective-plan group: entitlement the shell holds + quota lines. */
export function PlanGroup({ overview }: { overview: BillingOverviewView }) {
	const plan = overview.entitlement.plan;
	const features = overview.entitlement.features;
	return (
		<section className="settings__section" data-testid="billing-plan">
			<h4 className="settings__section-title">{t("shell.settings.billing.plan.title")}</h4>
			<p className="settings__section-summary">{t("shell.settings.billing.plan.summary")}</p>
			<SettingRow
				title={t("shell.settings.billing.plan.current")}
				control={
					<span className="settings__value-text" data-testid="billing-plan-name">
						{t(PLAN_LABEL_KEYS[plan])}
					</span>
				}
			/>
			<SettingRow
				title={t("shell.settings.billing.entitlement.title")}
				description={t("shell.settings.billing.entitlement.hint")}
				control={
					<span className="settings__value-text">
						{t(ENTITLEMENT_STATUS_KEYS[overview.entitlement.status])}
					</span>
				}
			/>
			<SettingRow
				title={t("shell.settings.billing.quota.storage")}
				control={<span className="settings__value-text">{t(PLAN_STORAGE_KEYS[plan])}</span>}
			/>
			<SettingRow
				title={t("shell.settings.billing.quota.relay")}
				control={
					<span className="settings__value-text">
						{plan === PlanTier.Free
							? t("shell.settings.billing.quota.relay.none")
							: t("shell.settings.billing.quota.relay.included")}
					</span>
				}
			/>
			{overview.quota !== null && overview.quota.storage.limitBytes !== null && (
				<SettingRow
					title={t("shell.settings.billing.quota.hostedStorage")}
					description={t("shell.settings.billing.quota.hostedStorage.hint")}
					control={
						<span className="settings__value-text" data-testid="billing-quota-storage">
							{overview.quota.storage.usedBytes !== null
								? t("shell.settings.billing.quota.usedOf", {
										used: formatBytes(overview.quota.storage.usedBytes),
										limit: formatBytes(overview.quota.storage.limitBytes),
									})
								: formatBytes(overview.quota.storage.limitBytes)}
						</span>
					}
				/>
			)}
			{overview.quota?.storage.over && (
				<p className="billing-section__error" role="alert" data-testid="billing-quota-over">
					{t("shell.settings.billing.quota.overStorage")}
				</p>
			)}
			{overview.quota !== null && overview.quota.egress.limitBytes !== null && (
				<SettingRow
					title={t("shell.settings.billing.quota.egress")}
					description={t("shell.settings.billing.quota.egress.hint")}
					control={
						<span className="settings__value-text" data-testid="billing-quota-egress">
							{t("shell.settings.billing.quota.egress.monthly", {
								limit: formatBytes(overview.quota.egress.limitBytes),
							})}
						</span>
					}
				/>
			)}
			{overview.storageBytesUsed !== null && (
				<SettingRow
					title={t("shell.settings.billing.storageUsed")}
					description={t("shell.settings.billing.storageUsed.hint")}
					control={
						<span className="settings__value-text" data-testid="billing-storage-used">
							{formatBytes(overview.storageBytesUsed)}
						</span>
					}
				/>
			)}
			{features.length > 0 && (
				<ul className="billing-section__features" data-testid="billing-features">
					{features.map((feature) => (
						<li key={feature} className="billing-section__feature">
							{t(FEATURE_LABEL_KEYS[feature])}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/** The paste-credential link form (signed-out state). The credential is
 *  write-only: sent once on Link, never read back. */
export function LinkForm({
	busy,
	failure,
	onLink,
	onOpenPortal,
}: {
	busy: boolean;
	failure: BillingSettingsFailure | null;
	onLink: (credential: string) => void;
	onOpenPortal: () => void;
}) {
	const [draft, setDraft] = useState("");
	const inputId = useId();
	return (
		<form
			className="billing-section__link-form"
			data-testid="billing-link-form"
			onSubmit={(e) => {
				e.preventDefault();
				if (draft.trim().length > 0) onLink(draft.trim());
			}}
		>
			<p className="settings__hint">{t("shell.settings.billing.link.hint")}</p>
			<label className="settings__field-label" htmlFor={inputId}>
				{t("shell.settings.billing.link.label")}
			</label>
			<div className="billing-section__link-row">
				<input
					id={inputId}
					className="settings__input"
					type="password"
					autoComplete="off"
					spellCheck={false}
					value={draft}
					placeholder={t("shell.settings.billing.link.placeholder")}
					onChange={(e) => setDraft(e.target.value)}
					disabled={busy}
				/>
				<Button
					variant={ButtonVariant.Primary}
					size={ButtonSize.Sm}
					disabled={busy || draft.trim().length === 0}
					loading={busy}
					data-testid="billing-link-submit"
					onClick={() => {
						if (draft.trim().length > 0) onLink(draft.trim());
					}}
				>
					{t("shell.settings.billing.link.action")}
				</Button>
			</div>
			{failure !== null && (
				<p className="billing-section__error" role="alert" data-testid="billing-link-error">
					{failureMessage(failure)}
				</p>
			)}
			<div className="billing-section__actions">
				<Button
					variant={ButtonVariant.Glass}
					size={ButtonSize.Sm}
					iconLeft={IconName.ArrowUpRight}
					onClick={onOpenPortal}
					data-testid="billing-open-portal"
				>
					{t("shell.settings.billing.portal.open")}
				</Button>
			</div>
		</form>
	);
}

/** The linked-account view: identity + live billing status + actions. */
export function LinkedAccount({
	account,
	summary,
	summaryFailure,
	busy,
	onRefresh,
	onUnlink,
	onOpenPortal,
	onCheckout,
}: {
	account: NonNullable<BillingOverviewView["account"]>;
	summary: BillingAccountSummaryView | null;
	summaryFailure: BillingSettingsFailure | null;
	busy: boolean;
	onRefresh: () => void;
	onUnlink: () => void;
	onOpenPortal: () => void;
	onCheckout: (plan: BillingCheckoutPlan, cycle: BillingCheckoutCycle) => void;
}) {
	const [plan, setPlan] = useState<BillingCheckoutPlan>(BillingCheckoutPlan.Plus);
	const [cycle, setCycle] = useState<BillingCheckoutCycle>(BillingCheckoutCycle.Yearly);
	const email = summary?.email ?? account.email;
	const billingStatus = summary?.billingStatus ?? null;
	return (
		<div data-testid="billing-account-linked">
			<SettingRow
				title={t("shell.settings.billing.account.email")}
				control={
					<span className="settings__value-text" data-testid="billing-account-email">
						{email ?? t("shell.settings.billing.account.emailUnknown")}
					</span>
				}
			/>
			<SettingRow
				title={t("shell.settings.billing.account.id")}
				control={<span className="settings__value-text">{account.id}</span>}
			/>
			{billingStatus !== null && (
				<SettingRow
					title={t("shell.settings.billing.accountStatus.title")}
					control={
						<span className="settings__value-text" data-testid="billing-account-status">
							{t(ACCOUNT_STATUS_KEYS[billingStatus])}
						</span>
					}
				/>
			)}
			{summaryFailure !== null && (
				<p className="billing-section__error" role="alert" data-testid="billing-summary-error">
					{failureMessage(summaryFailure)}
				</p>
			)}
			<div className="billing-section__upgrade" data-testid="billing-upgrade">
				<span className="settings__field-label">{t("shell.settings.billing.upgrade.title")}</span>
				<p className="settings__hint">{t("shell.settings.billing.upgrade.hint")}</p>
				<div className="billing-section__upgrade-row">
					<SettingSelect
						value={plan}
						options={[
							{ value: BillingCheckoutPlan.Plus, label: t("shell.settings.billing.plan.plus") },
							{ value: BillingCheckoutPlan.Pro, label: t("shell.settings.billing.plan.pro") },
							{ value: BillingCheckoutPlan.Team, label: t("shell.settings.billing.plan.team") },
						]}
						onChange={setPlan}
						ariaLabel={t("shell.settings.billing.upgrade.plan")}
					/>
					<SettingSelect
						value={cycle}
						options={[
							{
								value: BillingCheckoutCycle.Monthly,
								label: t("shell.settings.billing.cycle.monthly"),
							},
							{
								value: BillingCheckoutCycle.Yearly,
								label: t("shell.settings.billing.cycle.yearly"),
							},
						]}
						onChange={setCycle}
						ariaLabel={t("shell.settings.billing.upgrade.cycle")}
					/>
					<Button
						variant={ButtonVariant.Primary}
						size={ButtonSize.Sm}
						disabled={busy}
						loading={busy}
						onClick={() => onCheckout(plan, cycle)}
						data-testid="billing-checkout"
					>
						{t("shell.settings.billing.upgrade.action")}
					</Button>
				</div>
			</div>
			<div className="billing-section__actions">
				<Button
					variant={ButtonVariant.Glass}
					size={ButtonSize.Sm}
					iconLeft={IconName.ArrowUpRight}
					onClick={onOpenPortal}
					data-testid="billing-open-portal"
				>
					{t("shell.settings.billing.portal.manage")}
				</Button>
				<Button
					variant={ButtonVariant.Glass}
					size={ButtonSize.Sm}
					disabled={busy}
					onClick={onRefresh}
					data-testid="billing-refresh"
				>
					{t("shell.settings.billing.account.refresh")}
				</Button>
				<Button
					variant={ButtonVariant.Ghost}
					danger
					size={ButtonSize.Sm}
					disabled={busy}
					onClick={onUnlink}
					data-testid="billing-unlink"
				>
					{t("shell.settings.billing.account.unlink")}
				</Button>
			</div>
		</div>
	);
}

/** The invoices list — billing-edge-backed, linked accounts only. */
export function InvoicesGroup({
	invoices,
	failure,
	portalUrl,
}: {
	invoices: readonly BillingInvoiceView[] | null;
	failure: BillingSettingsFailure | null;
	portalUrl: string;
}) {
	return (
		<section className="settings__section" data-testid="billing-invoices">
			<h4 className="settings__section-title">{t("shell.settings.billing.invoices.title")}</h4>
			{failure !== null ? (
				<div role="status">
					<p className="settings__hint">{failureMessage(failure)}</p>
					<Button
						variant={ButtonVariant.Glass}
						size={ButtonSize.Sm}
						iconLeft={IconName.ArrowUpRight}
						onClick={() => openExternalUrl(portalUrl)}
					>
						{t("shell.settings.billing.invoices.openPortal")}
					</Button>
				</div>
			) : invoices === null ? (
				<p className="settings__loading" role="status">
					{t("shell.common.loading")}
				</p>
			) : invoices.length === 0 ? (
				<p className="settings__hint" data-testid="billing-invoices-empty">
					{t("shell.settings.billing.invoices.empty")}
				</p>
			) : (
				<ul className="billing-section__invoices">
					{invoices.map((invoice) => (
						<li key={invoice.id} className="billing-section__invoice">
							<span className="billing-section__invoice-date">{formatInvoiceDate(invoice.createdMs)}</span>
							<span className="billing-section__invoice-amount">{formatInvoiceAmount(invoice)}</span>
							<span className="billing-section__invoice-status">{invoice.status}</span>
							{invoice.hostedInvoiceUrl !== null && (
								<Button
									variant={ButtonVariant.Ghost}
									size={ButtonSize.Sm}
									iconLeft={IconName.ArrowUpRight}
									onClick={() => openExternalUrl(invoice.hostedInvoiceUrl as string)}
								>
									{t("shell.settings.billing.invoices.view")}
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

export function BillingSection() {
	// undefined = first load in flight; null = no vault session / stale preload.
	const [overview, setOverview] = useState<BillingOverviewView | null | undefined>(undefined);
	const [summary, setSummary] = useState<BillingAccountSummaryView | null>(null);
	const [summaryFailure, setSummaryFailure] = useState<BillingSettingsFailure | null>(null);
	const [invoices, setInvoices] = useState<readonly BillingInvoiceView[] | null>(null);
	const [invoicesFailure, setInvoicesFailure] = useState<BillingSettingsFailure | null>(null);
	const [linkFailure, setLinkFailure] = useState<BillingSettingsFailure | null>(null);
	const [busy, setBusy] = useState(false);

	const loadOverview = useCallback(async (): Promise<BillingOverviewView | null> => {
		const bridge = window.brainstorm?.billing;
		if (typeof bridge?.overview !== "function") {
			setOverview(null);
			return null;
		}
		const next = await bridge.overview();
		setOverview(next);
		return next;
	}, []);

	const loadRemote = useCallback(async () => {
		const bridge = window.brainstorm?.billing;
		if (!bridge) return;
		const [summaryResult, invoicesResult] = await Promise.all([
			bridge.refreshSummary(),
			bridge.invoices(),
		]);
		if (summaryResult.ok) {
			setSummary(summaryResult.value);
			setSummaryFailure(null);
		} else {
			setSummary(null);
			setSummaryFailure(summaryResult.reason);
		}
		if (invoicesResult.ok) {
			setInvoices([...invoicesResult.value]);
			setInvoicesFailure(null);
		} else {
			setInvoices(null);
			setInvoicesFailure(invoicesResult.reason);
		}
	}, []);

	useEffect(() => {
		let live = true;
		void loadOverview().then((loaded) => {
			if (live && loaded?.account) void loadRemote();
		});
		return () => {
			live = false;
		};
	}, [loadOverview, loadRemote]);

	const onLink = useCallback(
		(credential: string) => {
			const bridge = window.brainstorm?.billing;
			if (!bridge) return;
			setBusy(true);
			setLinkFailure(null);
			void bridge
				.link(credential)
				.then(async (result) => {
					if (!result.ok) {
						setLinkFailure(result.reason);
						return;
					}
					await loadOverview();
					await loadRemote();
				})
				.finally(() => setBusy(false));
		},
		[loadOverview, loadRemote],
	);

	const onUnlink = useCallback(() => {
		void (async () => {
			const confirmed = await confirm({
				title: t("shell.settings.billing.unlinkConfirm.title"),
				body: t("shell.settings.billing.unlinkConfirm.body"),
				confirmLabel: t("shell.settings.billing.account.unlink"),
				confirmVariant: ConfirmVariant.Destructive,
			});
			if (!confirmed) return;
			setBusy(true);
			try {
				await window.brainstorm?.billing?.unlink();
				setSummary(null);
				setSummaryFailure(null);
				setInvoices(null);
				setInvoicesFailure(null);
				await loadOverview();
			} finally {
				setBusy(false);
			}
		})();
	}, [loadOverview]);

	const onCheckout = useCallback((plan: BillingCheckoutPlan, cycle: BillingCheckoutCycle) => {
		const bridge = window.brainstorm?.billing;
		if (!bridge) return;
		setBusy(true);
		void bridge
			.checkout(plan, cycle)
			.then((result) => {
				if (result.ok) {
					openExternalUrl(result.value);
					setSummaryFailure(null);
				} else {
					setSummaryFailure(result.reason);
				}
			})
			.finally(() => setBusy(false));
	}, []);

	const onRefresh = useCallback(() => {
		void loadOverview();
		void loadRemote();
	}, [loadOverview, loadRemote]);

	if (overview === undefined) {
		return (
			<p className="settings__loading" role="status">
				{t("shell.common.loading")}
			</p>
		);
	}
	if (overview === null) {
		return <p className="settings__placeholder">{t("shell.settings.billing.unavailable")}</p>;
	}

	const portalUrl = overview.portalUrl;
	return (
		<div className="billing-section" data-testid="billing-section">
			<PlanGroup overview={overview} />
			<section className="settings__section" data-testid="billing-account">
				<h4 className="settings__section-title">{t("shell.settings.billing.account.title")}</h4>
				{overview.account ? (
					<LinkedAccount
						account={overview.account}
						summary={summary}
						summaryFailure={summaryFailure}
						busy={busy}
						onRefresh={onRefresh}
						onUnlink={onUnlink}
						onOpenPortal={() => openExternalUrl(portalUrl)}
						onCheckout={onCheckout}
					/>
				) : (
					<>
						<p className="settings__section-summary">{t("shell.settings.billing.account.none")}</p>
						{/* The upgrade CTA exists but stays disabled until an account is
						    linked — checkout needs the account credential. */}
						<div className="billing-section__actions">
							<Button
								variant={ButtonVariant.Primary}
								size={ButtonSize.Sm}
								disabled
								data-testid="billing-checkout-disabled"
							>
								{t("shell.settings.billing.upgrade.action")}
							</Button>
						</div>
						<p className="settings__hint" data-testid="billing-upgrade-locked">
							{t("shell.settings.billing.upgrade.needsAccount")}
						</p>
						<LinkForm
							busy={busy}
							failure={linkFailure}
							onLink={onLink}
							onOpenPortal={() => openExternalUrl(portalUrl)}
						/>
					</>
				)}
			</section>
			{overview.account && (
				<InvoicesGroup invoices={invoices} failure={invoicesFailure} portalUrl={portalUrl} />
			)}
		</div>
	);
}

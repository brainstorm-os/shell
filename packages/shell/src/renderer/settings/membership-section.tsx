/**
 * Settings → Membership — pricing UI + plan picker (visual-only v1).
 *
 * Three tiers (Free / Pro / Team), monthly⇄yearly toggle (yearly saves 20%),
 * comparison matrix, FAQ disclosures, trust strip. No backend wiring — the
 * "Upgrade" CTA pops a toast explaining checkout isn't live yet. The shape
 * is designed so a future iteration can swap in a `services.membership.*`
 * service without changing the markup.
 *
 * Conventions:
 *   - String enums for `Tier` and `BillingCycle` (CLAUDE.md §enums).
 *   - Every label routed through `t()` (CLAUDE.md §i18n).
 *   - Shared `<Button>`, `<Icon>` primitives — no bespoke chrome.
 */

import {
	type CompositeItemProps,
	Orientation,
	SelectionAttribute,
	useCompositeKeyboard,
} from "@brainstorm-os/sdk/a11y";
import { useMemo, useState } from "react";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Icon, IconName } from "../ui/icon";
import { ToastKind, pushToast } from "../ui/toasts";
import "./membership-section.css";

enum Tier {
	Free = "free",
	Pro = "pro",
	Team = "team",
}

enum BillingCycle {
	Monthly = "monthly",
	Yearly = "yearly",
}

type Plan = {
	tier: Tier;
	icon: IconName;
	nameKey: string;
	taglineKey: string;
	monthly: number;
	yearly: number;
	suffixOverrideKey?: string;
	features: readonly string[];
	highlighted: boolean;
};

const PLANS: readonly Plan[] = [
	{
		tier: Tier.Free,
		icon: IconName.Star,
		nameKey: "shell.settings.membership.tier.free.name",
		taglineKey: "shell.settings.membership.tier.free.tagline",
		monthly: 0,
		yearly: 0,
		features: [
			"shell.settings.membership.feature.free.1",
			"shell.settings.membership.feature.free.2",
			"shell.settings.membership.feature.free.3",
			"shell.settings.membership.feature.free.4",
		],
		highlighted: false,
	},
	{
		tier: Tier.Pro,
		icon: IconName.Lightning,
		nameKey: "shell.settings.membership.tier.pro.name",
		taglineKey: "shell.settings.membership.tier.pro.tagline",
		monthly: 12,
		yearly: 9,
		features: [
			"shell.settings.membership.feature.pro.1",
			"shell.settings.membership.feature.pro.2",
			"shell.settings.membership.feature.pro.3",
			"shell.settings.membership.feature.pro.4",
			"shell.settings.membership.feature.pro.5",
			"shell.settings.membership.feature.pro.6",
		],
		highlighted: true,
	},
	{
		tier: Tier.Team,
		icon: IconName.Crown,
		nameKey: "shell.settings.membership.tier.team.name",
		taglineKey: "shell.settings.membership.tier.team.tagline",
		monthly: 18,
		yearly: 14,
		suffixOverrideKey: "shell.settings.membership.tier.team.priceLabel",
		features: [
			"shell.settings.membership.feature.team.1",
			"shell.settings.membership.feature.team.2",
			"shell.settings.membership.feature.team.3",
			"shell.settings.membership.feature.team.4",
			"shell.settings.membership.feature.team.5",
			"shell.settings.membership.feature.team.6",
		],
		highlighted: false,
	},
];

type CompareCell = { kind: "label"; key: string } | { kind: "check" } | { kind: "dash" };

type CompareRow = {
	labelKey: string;
	free: CompareCell;
	pro: CompareCell;
	team: CompareCell;
};

const COMPARE_ROWS: readonly CompareRow[] = [
	{
		labelKey: "shell.settings.membership.compare.row.storage",
		free: { kind: "label", key: "shell.settings.membership.compare.row.storage.free" },
		pro: { kind: "label", key: "shell.settings.membership.compare.row.storage.pro" },
		team: { kind: "label", key: "shell.settings.membership.compare.row.storage.team" },
	},
	{
		labelKey: "shell.settings.membership.compare.row.devices",
		free: { kind: "label", key: "shell.settings.membership.compare.row.devices.free" },
		pro: { kind: "label", key: "shell.settings.membership.compare.row.devices.pro" },
		team: { kind: "label", key: "shell.settings.membership.compare.row.devices.team" },
	},
	{
		labelKey: "shell.settings.membership.compare.row.history",
		free: { kind: "label", key: "shell.settings.membership.compare.row.history.free" },
		pro: { kind: "label", key: "shell.settings.membership.compare.row.history.pro" },
		team: { kind: "label", key: "shell.settings.membership.compare.row.history.team" },
	},
	{
		labelKey: "shell.settings.membership.compare.row.ai",
		free: { kind: "label", key: "shell.settings.membership.compare.row.ai.free" },
		pro: { kind: "label", key: "shell.settings.membership.compare.row.ai.pro" },
		team: { kind: "label", key: "shell.settings.membership.compare.row.ai.team" },
	},
	{
		labelKey: "shell.settings.membership.compare.row.collab",
		free: { kind: "dash" },
		pro: { kind: "check" },
		team: { kind: "check" },
	},
	{
		labelKey: "shell.settings.membership.compare.row.support",
		free: { kind: "label", key: "shell.settings.membership.compare.row.support.free" },
		pro: { kind: "label", key: "shell.settings.membership.compare.row.support.pro" },
		team: { kind: "label", key: "shell.settings.membership.compare.row.support.team" },
	},
];

const FAQ_ENTRIES: ReadonlyArray<{ qKey: string; aKey: string }> = [
	{
		qKey: "shell.settings.membership.faq.q1",
		aKey: "shell.settings.membership.faq.a1",
	},
	{
		qKey: "shell.settings.membership.faq.q2",
		aKey: "shell.settings.membership.faq.a2",
	},
	{
		qKey: "shell.settings.membership.faq.q3",
		aKey: "shell.settings.membership.faq.a3",
	},
	{
		qKey: "shell.settings.membership.faq.q4",
		aKey: "shell.settings.membership.faq.a4",
	},
];

const TRUST_ITEMS: ReadonlyArray<{ icon: IconName; titleKey: string; bodyKey: string }> = [
	{
		icon: IconName.ShieldCheck,
		titleKey: "shell.settings.membership.trust.encrypted.title",
		bodyKey: "shell.settings.membership.trust.encrypted.body",
	},
	{
		icon: IconName.Heart,
		titleKey: "shell.settings.membership.trust.local.title",
		bodyKey: "shell.settings.membership.trust.local.body",
	},
	{
		icon: IconName.Sparkle,
		titleKey: "shell.settings.membership.trust.cancel.title",
		bodyKey: "shell.settings.membership.trust.cancel.body",
	},
];

export function MembershipSection() {
	const [cycle, setCycle] = useState<BillingCycle>(BillingCycle.Yearly);
	const [currentTier] = useState<Tier>(Tier.Free);

	const onPick = (tier: Tier) => {
		if (tier === currentTier) return;
		pushToast({
			kind: ToastKind.Info,
			title: t("shell.settings.membership.checkout.placeholder.title"),
			body: t("shell.settings.membership.checkout.placeholder.body"),
		});
	};

	return (
		<section className="membership">
			<MembershipHero cycle={cycle} onCycleChange={setCycle} />
			<div className="membership__grid">
				{PLANS.map((plan) => (
					<PlanCard
						key={plan.tier}
						plan={plan}
						cycle={cycle}
						isCurrent={plan.tier === currentTier}
						onPick={onPick}
					/>
				))}
			</div>
			<TrustStrip />
			<CompareMatrix />
			<FaqList />
		</section>
	);
}

function MembershipHero({
	cycle,
	onCycleChange,
}: {
	cycle: BillingCycle;
	onCycleChange: (next: BillingCycle) => void;
}) {
	// KBN: the billing-cycle toggle is a horizontal radiogroup — ←/→ move +
	// select (aria-checked via the hook). Index 0 = Monthly, 1 = Yearly.
	const cycles = [BillingCycle.Monthly, BillingCycle.Yearly] as const;
	const selectCycle = (index: number) => {
		const next = cycles[index];
		if (next) onCycleChange(next);
	};
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: cycles.length,
		activeIndex: cycle === BillingCycle.Monthly ? 0 : 1,
		onActiveIndexChange: selectCycle,
		onActivate: selectCycle,
		role: "radiogroup",
		itemRole: "radio",
		selectionAttribute: SelectionAttribute.AriaChecked,
	});
	return (
		<header className="membership__hero">
			<h2 className="membership__title">{t("shell.settings.membership.title")}</h2>
			<p className="membership__subtitle">{t("shell.settings.membership.subtitle")}</p>
			<div
				className="membership__cycle"
				{...containerProps}
				aria-label={t("shell.settings.membership.cycle.label")}
			>
				<CycleOption
					value={BillingCycle.Monthly}
					labelKey="shell.settings.membership.cycle.monthly"
					selected={cycle === BillingCycle.Monthly}
					onPick={onCycleChange}
					itemProps={getItemProps(0)}
				/>
				<CycleOption
					value={BillingCycle.Yearly}
					labelKey="shell.settings.membership.cycle.yearly"
					selected={cycle === BillingCycle.Yearly}
					onPick={onCycleChange}
					itemProps={getItemProps(1)}
					trailing={
						<span className="membership__savings">{t("shell.settings.membership.cycle.savings")}</span>
					}
				/>
			</div>
		</header>
	);
}

function CycleOption({
	value,
	labelKey,
	selected,
	onPick,
	trailing,
	itemProps,
}: {
	value: BillingCycle;
	labelKey: string;
	selected: boolean;
	onPick: (next: BillingCycle) => void;
	trailing?: React.ReactNode;
	/** Composite radio props (role/tabindex/aria-checked/id) from the parent's
	 *  `useCompositeKeyboard` — KBN-G-roles: the role flows through the hook. */
	itemProps: CompositeItemProps;
}) {
	return (
		<button
			type="button"
			{...itemProps}
			className={
				selected
					? "membership__cycle-option membership__cycle-option--selected"
					: "membership__cycle-option"
			}
			onClick={() => onPick(value)}
		>
			<span>{t(labelKey)}</span>
			{trailing}
		</button>
	);
}

function PlanCard({
	plan,
	cycle,
	isCurrent,
	onPick,
}: {
	plan: Plan;
	cycle: BillingCycle;
	isCurrent: boolean;
	onPick: (tier: Tier) => void;
}) {
	const price = cycle === BillingCycle.Yearly ? plan.yearly : plan.monthly;
	const isFree = plan.monthly === 0;
	const tierName = t(plan.nameKey);
	const classes = ["membership__card"];
	if (plan.highlighted) classes.push("membership__card--highlight");
	if (isCurrent) classes.push("membership__card--current");

	return (
		<article className={classes.join(" ")}>
			{plan.highlighted && (
				<span className="membership__badge membership__badge--recommended">
					{t("shell.settings.membership.recommended")}
				</span>
			)}
			{isCurrent && (
				<span className="membership__badge membership__badge--current">
					{t("shell.settings.membership.currentPlan")}
				</span>
			)}
			<div className="membership__card-head">
				<span className="membership__card-icon" aria-hidden="true">
					<Icon name={plan.icon} size={20} />
				</span>
				<h3 className="membership__card-name">{tierName}</h3>
				<p className="membership__card-tagline">{t(plan.taglineKey)}</p>
			</div>
			<div className="membership__price">
				{isFree ? (
					<span className="membership__price-value">{t("shell.settings.membership.priceFree")}</span>
				) : (
					<>
						<span className="membership__price-currency">{t("shell.settings.membership.currency")}</span>
						<span className="membership__price-value">{price}</span>
						<span className="membership__price-suffix">
							{plan.suffixOverrideKey
								? t(plan.suffixOverrideKey)
								: t(
										cycle === BillingCycle.Yearly
											? "shell.settings.membership.priceSuffix.yearly"
											: "shell.settings.membership.priceSuffix.monthly",
									)}
						</span>
					</>
				)}
			</div>
			<ul className="membership__features">
				{plan.features.map((featureKey) => (
					<li key={featureKey} className="membership__feature">
						<span className="membership__feature-check" aria-hidden="true">
							<Icon name={IconName.CheckCircle} size={16} weight="fill" />
						</span>
						<span>{t(featureKey)}</span>
					</li>
				))}
			</ul>
			<div className="membership__card-foot">
				<PlanCta plan={plan} isCurrent={isCurrent} tierName={tierName} onPick={onPick} />
			</div>
		</article>
	);
}

function PlanCta({
	plan,
	isCurrent,
	tierName,
	onPick,
}: {
	plan: Plan;
	isCurrent: boolean;
	tierName: string;
	onPick: (tier: Tier) => void;
}) {
	if (isCurrent) {
		return (
			<Button
				variant={ButtonVariant.Neutral}
				size={ButtonSize.Md}
				disabled
				className="membership__cta"
			>
				{t("shell.settings.membership.cta.stay")}
			</Button>
		);
	}
	const label =
		plan.tier === Tier.Team
			? t("shell.settings.membership.cta.contact")
			: t("shell.settings.membership.cta.upgrade", { tier: tierName });
	return (
		<Button
			variant={plan.highlighted ? ButtonVariant.Primary : ButtonVariant.Glass}
			size={ButtonSize.Md}
			onClick={() => onPick(plan.tier)}
			className="membership__cta"
		>
			{label}
		</Button>
	);
}

function TrustStrip() {
	return (
		<ul className="membership__trust">
			{TRUST_ITEMS.map((item) => (
				<li key={item.titleKey} className="membership__trust-item">
					<span className="membership__trust-icon" aria-hidden="true">
						<Icon name={item.icon} size={18} weight="fill" />
					</span>
					<div className="membership__trust-copy">
						<span className="membership__trust-title">{t(item.titleKey)}</span>
						<span className="membership__trust-body">{t(item.bodyKey)}</span>
					</div>
				</li>
			))}
		</ul>
	);
}

function CompareMatrix() {
	return (
		<div className="membership__compare">
			<h3 className="membership__section-title">{t("shell.settings.membership.compareTitle")}</h3>
			<table className="membership__compare-table">
				<thead>
					<tr className="membership__compare-row membership__compare-row--head">
						<th scope="col">{t("shell.settings.membership.compare.feature")}</th>
						{PLANS.map((p) => (
							<th key={p.tier} scope="col">
								{t(p.nameKey)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{COMPARE_ROWS.map((row) => (
						<tr className="membership__compare-row" key={row.labelKey}>
							<th className="membership__compare-feature" scope="row">
								{t(row.labelKey)}
							</th>
							<CompareCellView cell={row.free} />
							<CompareCellView cell={row.pro} />
							<CompareCellView cell={row.team} />
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function CompareCellView({ cell }: { cell: CompareCell }) {
	if (cell.kind === "check") {
		return (
			<td className="membership__compare-cell">
				<span
					className="membership__compare-check"
					aria-label={t("shell.settings.membership.compare.included")}
				>
					<Icon name={IconName.CheckCircle} size={16} weight="fill" />
				</span>
			</td>
		);
	}
	if (cell.kind === "dash") {
		return (
			<td
				className="membership__compare-cell membership__compare-cell--muted"
				aria-label={t("shell.settings.membership.compare.notIncluded")}
			>
				—
			</td>
		);
	}
	return <td className="membership__compare-cell">{t(cell.key)}</td>;
}

function FaqList() {
	const ids = useMemo(() => FAQ_ENTRIES.map((_, i) => `m-faq-${i}`), []);
	return (
		<div className="membership__faq">
			<h3 className="membership__section-title">{t("shell.settings.membership.faq.title")}</h3>
			<div className="membership__faq-list">
				{FAQ_ENTRIES.map((entry, i) => (
					<details className="membership__faq-item" key={entry.qKey} name={ids[i]}>
						<summary className="membership__faq-summary">
							<span>{t(entry.qKey)}</span>
							<span className="membership__faq-caret" aria-hidden="true">
								<Icon name={IconName.CaretDown} size={14} />
							</span>
						</summary>
						<p className="membership__faq-answer">{t(entry.aKey)}</p>
					</details>
				))}
			</div>
		</div>
	);
}

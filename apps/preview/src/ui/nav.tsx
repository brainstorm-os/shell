/**
 * Header nav group — prev / counter / next. Disabled when there is no
 * gallery to walk (≤1 sibling), where the arrows are noise.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import type { ReactElement } from "react";
import { t } from "../i18n";

export function Nav({
	disabled,
	counter,
	onPrev,
	onNext,
}: {
	disabled: boolean;
	counter: string;
	onPrev: () => void;
	onNext: () => void;
}): ReactElement {
	return (
		<div className="preview__nav">
			<button
				type="button"
				className="header-icon-btn"
				aria-label={t("nav.prev")}
				data-bs-tooltip={t("nav.prev")}
				disabled={disabled}
				onClick={onPrev}
			>
				<Icon name={IconName.CaretLeft} />
			</button>
			<span className="preview__counter">{counter}</span>
			<button
				type="button"
				className="header-icon-btn"
				aria-label={t("nav.next")}
				data-bs-tooltip={t("nav.next")}
				disabled={disabled}
				onClick={onNext}
			>
				<Icon name={IconName.CaretRight} />
			</button>
		</div>
	);
}

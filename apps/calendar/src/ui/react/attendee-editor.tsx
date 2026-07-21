/**
 * Attendee / RSVP editor (React) — the participant list inside the
 * event-detail surface. An add-row (name + optional email) appends to the
 * list; each existing attendee carries an RSVP `<SelectMenu>` (the shared
 * select control) and a remove affordance. A roll-up line summarizes
 * "2 going · 1 maybe · 0 not going".
 *
 * Controlled: the host owns `value` and updates it from `onChange`.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { SelectMenu } from "@brainstorm-os/sdk/select-menu";
import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";
import { type TKey, t } from "../../i18n/t";
import { ATTENDEE_RSVPS, makeAttendee, rsvpCounts } from "../../logic/attendees";
import { type Attendee, AttendeeRsvp } from "../../types/attendee";

const RSVP_LABEL_KEY: Record<AttendeeRsvp, TKey> = {
	[AttendeeRsvp.Accepted]: "calendar.attendee.rsvp.accepted",
	[AttendeeRsvp.Tentative]: "calendar.attendee.rsvp.tentative",
	[AttendeeRsvp.Declined]: "calendar.attendee.rsvp.declined",
	[AttendeeRsvp.NeedsAction]: "calendar.attendee.rsvp.needsAction",
};

export type AttendeeEditorProps = {
	value: readonly Attendee[];
	onChange(value: Attendee[]): void;
};

export function AttendeeEditor({ value, onChange }: AttendeeEditorProps) {
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");

	const setRsvp = (index: number, rsvp: AttendeeRsvp): void => {
		onChange(value.map((a, i) => (i === index ? { ...a, rsvp } : { ...a })));
	};
	const remove = (index: number): void => {
		onChange(value.filter((_, i) => i !== index).map((a) => ({ ...a })));
	};
	const commitAdd = (): void => {
		const attendee = makeAttendee(name, email);
		if (attendee) {
			const key = (attendee.email ?? attendee.name).toLowerCase();
			const exists = value.some((a) => (a.email ?? a.name).toLowerCase() === key);
			if (!exists) onChange([...value.map((a) => ({ ...a })), attendee]);
		}
		setName("");
		setEmail("");
	};
	const onAddKey = (event: ReactKeyboardEvent): void => {
		// keyboard-exempt: Enter commits this editable <input>; the shortcut
		// registry suppresses single keys in editable fields by design.
		if (event.key === "Enter") {
			event.preventDefault();
			commitAdd();
		}
	};

	const counts = rsvpCounts(value);

	return (
		<div className="cal-attendees">
			<ul className="cal-attendees__list">
				{value.length === 0 ? (
					<li className="cal-attendees__empty">{t("calendar.attendee.empty")}</li>
				) : (
					value.map((attendee, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: positional row; RSVP/remove key off index
						<li key={index} className="cal-attendees__item">
							<div className="cal-attendees__identity">
								<span className="cal-attendees__name">{attendee.name}</span>
								{attendee.email && attendee.email !== attendee.name ? (
									<span className="cal-attendees__email">{attendee.email}</span>
								) : null}
							</div>
							<SelectMenu
								className="cal-attendees__rsvp bs-select--sm"
								ariaLabel={t("calendar.attendee.rsvpLabel", { name: attendee.name })}
								value={attendee.rsvp}
								options={ATTENDEE_RSVPS.map((state) => ({
									value: state,
									label: t(RSVP_LABEL_KEY[state]),
								}))}
								onChange={(rsvp) => setRsvp(index, rsvp)}
							/>
							<button
								type="button"
								className="cal-attendees__remove"
								aria-label={t("calendar.attendee.remove", { name: attendee.name })}
								onClick={() => remove(index)}
							>
								<Icon name={IconName.Close} />
							</button>
						</li>
					))
				)}
			</ul>
			{value.length > 0 ? (
				<p className="cal-attendees__summary" aria-live="polite">
					{t("calendar.attendee.summary", {
						accepted: counts[AttendeeRsvp.Accepted],
						tentative: counts[AttendeeRsvp.Tentative],
						declined: counts[AttendeeRsvp.Declined],
					})}
				</p>
			) : null}
			<div className="cal-attendees__add">
				<input
					type="text"
					className="bs-input cal-detail__input"
					placeholder={t("calendar.attendee.addNamePlaceholder")}
					value={name}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={onAddKey}
				/>
				<input
					type="email"
					className="bs-input cal-detail__input"
					placeholder={t("calendar.attendee.addEmailPlaceholder")}
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					onKeyDown={onAddKey}
				/>
				<button type="button" className="bs-btn bs-btn--secondary" onClick={commitAdd}>
					{t("calendar.attendee.add")}
				</button>
			</div>
		</div>
	);
}

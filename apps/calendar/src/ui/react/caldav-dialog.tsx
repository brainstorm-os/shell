/**
 * CalDAV sync dialog (9.15.19) — connect a server with an app password,
 * subscribe calendar collections, and run a two-way sync, all through the
 * shell's `caldav` service. The renderer never holds the password after
 * the connect call resolves — custody is shell-side (Tier 2).
 *
 * Conflict policy surfaced here mirrors the engine: server-wins with
 * local redo — the summary's `conflicts` count tells the user what to
 * re-apply.
 */

import type {
	CalDavCalendarInfo,
	CalDavService,
	CalDavSyncSummary,
} from "@brainstorm-os/sdk-types";
import { Popover, PopoverBodyPadding, PopoverSize } from "@brainstorm-os/sdk/popover";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { plural, t } from "../../i18n/t";
import type { EntitiesService, EntityRecord } from "../../storage/runtime";

export const CALDAV_ACCOUNT_TYPE = "brainstorm/CalDavAccount/v1";
export const CALDAV_CALENDAR_TYPE = "brainstorm/CalDavCalendar/v1";

export type CalDavDialogProps = {
	caldav: CalDavService;
	entities: EntitiesService;
	onClose: () => void;
	notify?: (message: string) => void;
};

type AccountRow = { id: string; displayName: string; username: string; enabled: boolean };
type CalendarRow = { id: string; url: string; displayName: string; lastSyncAt: string | null };

function toAccountRow(record: EntityRecord): AccountRow {
	const p = record.properties;
	return {
		id: record.id,
		displayName: typeof p.displayName === "string" ? p.displayName : record.id,
		username: typeof p.username === "string" ? p.username : "",
		enabled: p.enabled === true,
	};
}

function toCalendarRow(record: EntityRecord): CalendarRow {
	const p = record.properties;
	return {
		id: record.id,
		url: typeof p.url === "string" ? p.url : "",
		displayName: typeof p.displayName === "string" ? p.displayName : record.id,
		lastSyncAt: typeof p.lastSyncAt === "string" ? p.lastSyncAt : null,
	};
}

function summaryMessage(summary: CalDavSyncSummary): string {
	const base = t("calendar.caldav.syncDone", {
		pulled: String(summary.pulled),
		pushed: String(summary.pushedCreated + summary.pushedUpdated),
	});
	return summary.conflicts > 0
		? `${base} ${plural(
				summary.conflicts,
				"calendar.caldav.syncConflicts.one",
				"calendar.caldav.syncConflicts.other",
			)}`
		: base;
}

export function CalDavDialog({ caldav, entities, onClose, notify }: CalDavDialogProps) {
	const [account, setAccount] = useState<AccountRow | null>(null);
	const [subscribed, setSubscribed] = useState<CalendarRow[]>([]);
	const [serverCalendars, setServerCalendars] = useState<CalDavCalendarInfo[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [serverUrl, setServerUrl] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");

	const refresh = useCallback(async (): Promise<AccountRow | null> => {
		const accounts = (await entities.query({ type: CALDAV_ACCOUNT_TYPE }))
			.map(toAccountRow)
			.filter((a) => a.enabled);
		const calendars = (await entities.query({ type: CALDAV_CALENDAR_TYPE })).map(toCalendarRow);
		const active = accounts[0] ?? null;
		setAccount(active);
		setSubscribed(calendars);
		return active;
	}, [entities]);

	useEffect(() => {
		void refresh().catch(() => setError(t("calendar.caldav.loadFailed")));
	}, [refresh]);

	const run = async (work: () => Promise<void>): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			await work();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	const connect = (event: FormEvent): void => {
		event.preventDefault();
		void run(async () => {
			const result = await caldav.connect({ serverUrl, username, password, label: serverUrl });
			setPassword("");
			setServerCalendars(result.calendars);
			await refresh();
			notify?.(t("calendar.caldav.connected"));
		});
	};

	const loadServerCalendars = (accountRef: string): void => {
		void run(async () => {
			setServerCalendars(await caldav.listCalendars({ accountRef }));
		});
	};

	const addCalendar = (accountRef: string, info: CalDavCalendarInfo): void => {
		void run(async () => {
			await caldav.addCalendar({
				accountRef,
				url: info.url,
				displayName: info.displayName,
				...(info.color !== null ? { color: info.color } : {}),
			});
			await refresh();
		});
	};

	const syncNow = (calendarRef: string): void => {
		void run(async () => {
			const summary = await caldav.syncNow({ calendarRef });
			await refresh();
			notify?.(summaryMessage(summary));
		});
	};

	const disconnect = (accountRef: string): void => {
		void run(async () => {
			await caldav.disconnect({ accountRef });
			setServerCalendars([]);
			await refresh();
		});
	};

	const subscribedUrls = new Set(subscribed.map((c) => c.url));
	const addable = serverCalendars.filter((c) => c.supportsEvents && !subscribedUrls.has(c.url));

	return (
		<Popover
			title={t("calendar.caldav.title")}
			onClose={onClose}
			size={PopoverSize.Medium}
			bodyPadding={PopoverBodyPadding.Comfortable}
			testId="caldav-dialog"
		>
			{error ? (
				<p className="cal-caldav__error" role="alert">
					{error}
				</p>
			) : null}

			{account === null ? (
				<form className="cal-caldav__form" onSubmit={connect}>
					<p className="cal-caldav__hint">{t("calendar.caldav.connectHint")}</p>
					<label className="cal-detail__field">
						<span className="cal-detail__label">{t("calendar.caldav.serverUrl")}</span>
						<input
							className="bs-input cal-detail__input"
							type="url"
							required
							placeholder="https://caldav.example.com/"
							value={serverUrl}
							onChange={(e) => setServerUrl(e.target.value)}
						/>
					</label>
					<label className="cal-detail__field">
						<span className="cal-detail__label">{t("calendar.caldav.username")}</span>
						<input
							className="bs-input cal-detail__input"
							type="text"
							required
							autoComplete="username"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
						/>
					</label>
					<label className="cal-detail__field">
						<span className="cal-detail__label">{t("calendar.caldav.password")}</span>
						<input
							className="bs-input cal-detail__input"
							type="password"
							required
							autoComplete="current-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
						/>
					</label>
					<div className="cal-detail__footer">
						<span className="cal-detail__footer-spacer" />
						<button type="submit" className="bs-btn" data-bs-primary disabled={busy}>
							{t("calendar.caldav.connect")}
						</button>
					</div>
				</form>
			) : (
				<div className="cal-caldav__connected">
					<div className="cal-caldav__account">
						<span className="cal-caldav__account-name">{account.displayName}</span>
						<span className="cal-caldav__account-user">{account.username}</span>
						<button
							type="button"
							className="bs-btn bs-btn--secondary"
							disabled={busy}
							onClick={() => disconnect(account.id)}
						>
							{t("calendar.caldav.disconnect")}
						</button>
					</div>

					<h3 className="cal-caldav__heading">{t("calendar.caldav.subscribed")}</h3>
					{subscribed.length === 0 ? (
						<p className="cal-caldav__hint">{t("calendar.caldav.noneSubscribed")}</p>
					) : (
						<ul className="cal-caldav__list">
							{subscribed.map((calendar) => (
								<li key={calendar.id} className="cal-caldav__item">
									<span className="cal-caldav__item-name">{calendar.displayName}</span>
									<button
										type="button"
										className="bs-btn bs-btn--secondary"
										disabled={busy}
										onClick={() => syncNow(calendar.id)}
									>
										{t("calendar.caldav.syncNow")}
									</button>
								</li>
							))}
						</ul>
					)}

					<h3 className="cal-caldav__heading">{t("calendar.caldav.onServer")}</h3>
					{serverCalendars.length === 0 ? (
						<button
							type="button"
							className="bs-btn bs-btn--secondary"
							disabled={busy}
							onClick={() => loadServerCalendars(account.id)}
						>
							{t("calendar.caldav.loadCalendars")}
						</button>
					) : addable.length === 0 ? (
						<p className="cal-caldav__hint">{t("calendar.caldav.allSubscribed")}</p>
					) : (
						<ul className="cal-caldav__list">
							{addable.map((info) => (
								<li key={info.url} className="cal-caldav__item">
									<span className="cal-caldav__item-name">{info.displayName}</span>
									<button
										type="button"
										className="bs-btn bs-btn--secondary"
										disabled={busy}
										onClick={() => addCalendar(account.id, info)}
									>
										{t("calendar.caldav.add")}
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</Popover>
	);
}

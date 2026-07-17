/**
 * Help-1 — search input + result list. Calls
 * `window.brainstorm.help.search` for every query change (debounced —
 * the FTS5 index is tens of microseconds per query, so a 120 ms trailing
 * debounce is enough to dodge noisy keystrokes without feeling laggy).
 *
 * The snippet returned by FTS5 carries `<mark>…</mark>` wrappers that
 * the indexer controls (no user-controlled HTML); the renderer below
 * parses those wrappers into safe React `<mark>` nodes via a tiny
 * tokeniser — never `dangerouslySetInnerHTML`.
 */

import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import type { HelpHit } from "../../preload";
import { t } from "../i18n/t";
import { TextField, TextFieldSize } from "../ui/text-field";

export type HelpSearchbarProps = {
	readonly onPick: (hit: HelpHit) => void;
	readonly search: (text: string, limit?: number) => Promise<HelpHit[]>;
	readonly inputRef?: React.RefObject<HTMLInputElement | null>;
};

const DEBOUNCE_MS = 120;
const MAX_HITS = 20;

export function HelpSearchbar({ onPick, search, inputRef }: HelpSearchbarProps) {
	const [text, setText] = useState("");
	const [hits, setHits] = useState<HelpHit[]>([]);
	const [searching, setSearching] = useState(false);

	const seqRef = useRef(0);

	useEffect(() => {
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			setHits([]);
			setSearching(false);
			return;
		}
		setSearching(true);
		const seq = ++seqRef.current;
		const timer = setTimeout(() => {
			void search(trimmed, MAX_HITS)
				.then((next) => {
					if (seqRef.current !== seq) return;
					setHits(next);
				})
				.catch(() => {
					if (seqRef.current !== seq) return;
					setHits([]);
				})
				.finally(() => {
					if (seqRef.current !== seq) return;
					setSearching(false);
				});
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [text, search]);

	const trimmed = text.trim();
	const showResults = trimmed.length > 0;

	return (
		<div className="help__searchbar" role="search">
			<TextField
				ref={inputRef ?? null}
				type="search"
				size={TextFieldSize.Md}
				value={text}
				onChange={setText}
				placeholder={t("shell.help.search.placeholder")}
				aria-label={t("shell.help.search.label")}
				data-testid="help-search-input"
			/>
			{showResults && (
				<ul
					className="help__search-results"
					aria-label={t("shell.help.search.results")}
					data-testid="help-search-results"
				>
					{!searching && hits.length === 0 && (
						<li className="help__search-empty">{t("shell.help.search.empty")}</li>
					)}
					{hits.map((hit) => (
						<li key={hit.topicId}>
							<button
								type="button"
								className="help__search-hit"
								onClick={() => onPick(hit)}
								data-testid="help-search-hit"
							>
								<span className="help__search-hit-title">{hit.title}</span>
								<span className="help__search-hit-snippet">{renderSnippet(hit.snippet)}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function renderSnippet(raw: string): ReactNode {
	const out: ReactNode[] = [];
	let i = 0;
	while (i < raw.length) {
		const open = raw.indexOf("<mark>", i);
		if (open === -1) {
			out.push(<Fragment key={i}>{raw.slice(i)}</Fragment>);
			break;
		}
		if (open > i) out.push(<Fragment key={`t-${i}`}>{raw.slice(i, open)}</Fragment>);
		const close = raw.indexOf("</mark>", open + 6);
		if (close === -1) {
			out.push(<Fragment key={`t-${open}`}>{raw.slice(open + 6)}</Fragment>);
			break;
		}
		out.push(<mark key={`m-${open}`}>{raw.slice(open + 6, close)}</mark>);
		i = close + 7;
	}
	return <>{out}</>;
}

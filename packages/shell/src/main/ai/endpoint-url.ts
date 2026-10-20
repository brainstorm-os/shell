/**
 * Agent-14 — the base-URL policy for a user-added OpenAI-compatible endpoint
 * (Settings → AI → Custom endpoints, and the Ollama endpoint field).
 *
 * The URL is user consent to egress: adding an endpoint is what authorises
 * the shell to POST transcripts there. The request itself still rides the
 * network broker (`executeNetworkFetch`: SSRF floor, blocked ports, DNS
 * pinning, shared proxy config, egress audit) — this module only decides
 * whether the URL is acceptable to store and whether the broker may relax its
 * private-range rejection for it.
 *
 * Policy:
 *  - http/https only; no userinfo (a key in the URL would land in the audit
 *    log and the settings file), no query, no fragment.
 *  - plain `http:` is allowed only for loopback / LAN-private hosts — a
 *    transcript sent in cleartext over the public internet is refused.
 *  - the SSRF hard floor (malformed, blocked port) applies unconditionally.
 *  - `privateHost` is true when the host is loopback / RFC1918 / link-local /
 *    a LAN-only name. Only then does the transport set `allowPrivate`, so a
 *    public hostname that later resolves to a private address is still caught
 *    by the broker's post-DNS check (no DNS-rebinding into the LAN).
 */

import { EndpointUrlError } from "../../shared/ai-endpoints";
import { SsrfRejection, checkUrl } from "../network/ssrf-guard";

export type EndpointUrlCheck =
	| { readonly ok: true; readonly url: string; readonly privateHost: boolean }
	| { readonly ok: false; readonly error: EndpointUrlError };

export const ENDPOINT_URL_MAX_LENGTH = 2048;

/** Single-label hosts and these suffixes never resolve on the public internet. */
const LAN_SUFFIXES: readonly string[] = [".lan", ".home.arpa", ".internal", ".localdomain"];

function isLanName(hostname: string): boolean {
	if (!hostname.includes(".") && !hostname.includes(":")) return true;
	return LAN_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

export function checkEndpointUrl(input: unknown): EndpointUrlCheck {
	if (typeof input !== "string") return { ok: false, error: EndpointUrlError.Malformed };
	const trimmed = input.trim();
	if (trimmed.length === 0) return { ok: false, error: EndpointUrlError.Malformed };
	if (trimmed.length > ENDPOINT_URL_MAX_LENGTH)
		return { ok: false, error: EndpointUrlError.TooLong };
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, error: EndpointUrlError.Malformed };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, error: EndpointUrlError.Scheme };
	}
	if (url.username.length > 0 || url.password.length > 0) {
		return { ok: false, error: EndpointUrlError.Credentials };
	}
	if (
		url.search.length > 0 ||
		url.hash.length > 0 ||
		trimmed.includes("?") ||
		trimmed.includes("#")
	) {
		return { ok: false, error: EndpointUrlError.QueryOrFragment };
	}

	const strict = checkUrl(url.toString());
	let privateHost: boolean;
	if (strict.ok) {
		privateHost = isLanName(strict.hostname);
	} else {
		const relaxed = checkUrl(url.toString(), { allowPrivate: true });
		if (!relaxed.ok) {
			return {
				ok: false,
				error:
					relaxed.reason === SsrfRejection.BlockedPort
						? EndpointUrlError.BlockedPort
						: EndpointUrlError.Malformed,
			};
		}
		privateHost = true;
	}
	if (url.protocol === "http:" && !privateHost) {
		return { ok: false, error: EndpointUrlError.InsecurePublic };
	}
	return { ok: true, url: url.toString().replace(/\/+$/, ""), privateHost };
}

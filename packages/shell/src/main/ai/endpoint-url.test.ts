import { describe, expect, it } from "vitest";
import { EndpointUrlError } from "../../shared/ai-endpoints";
import { checkEndpointUrl } from "./endpoint-url";

describe("checkEndpointUrl", () => {
	it("accepts a public https endpoint, normalised without a trailing slash", () => {
		expect(checkEndpointUrl(" https://openrouter.ai/api/v1/ ")).toEqual({
			ok: true,
			url: "https://openrouter.ai/api/v1",
			privateHost: false,
		});
	});

	it.each([
		["http://localhost:1234/v1"],
		["http://127.0.0.1:11434"],
		["http://192.168.1.20:8080/v1"],
		["http://10.0.0.5/v1"],
		["http://[::1]:1234/v1"],
		["http://nas.lan:1234/v1"],
		["http://gpu-box:8000/v1"],
		["http://studio.local:1234/v1"],
		["https://router.home.arpa/v1"],
	])("allows %s and flags it as a private host", (url) => {
		const check = checkEndpointUrl(url);
		expect(check.ok && check.privateHost).toBe(true);
	});

	it.each([
		["http://api.example.com/v1", EndpointUrlError.InsecurePublic],
		["http://8.8.8.8/v1", EndpointUrlError.InsecurePublic],
		["ftp://example.com", EndpointUrlError.Scheme],
		["file:///etc/passwd", EndpointUrlError.Scheme],
		["javascript:alert(1)", EndpointUrlError.Scheme],
		["https://user:sk-secret@example.com/v1", EndpointUrlError.Credentials],
		["https://example.com/v1?key=sk", EndpointUrlError.QueryOrFragment],
		["https://example.com/v1#x", EndpointUrlError.QueryOrFragment],
		["https://example.com:22/v1", EndpointUrlError.BlockedPort],
		["http://127.0.0.1:6379", EndpointUrlError.BlockedPort],
		["not a url", EndpointUrlError.Malformed],
		["", EndpointUrlError.Malformed],
		[`https://example.com/${"a".repeat(2100)}`, EndpointUrlError.TooLong],
	])("rejects %s", (url, error) => {
		expect(checkEndpointUrl(url)).toEqual({ ok: false, error });
	});

	it("rejects non-string input", () => {
		expect(checkEndpointUrl(42)).toEqual({ ok: false, error: EndpointUrlError.Malformed });
	});
});

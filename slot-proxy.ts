/**
 * A parent-owned loopback route that lets an extension-free child use a rotation slot.
 *
 * ## The problem this exists for
 *
 * Anything spawned without this extension loaded — a memory extension consolidating its notes,
 * an external CLI, or a bare `pi -p --no-extensions` call — can be pointed at a published slot
 * explicitly (or through Pi's saved startup default). Publishing that slot's *name* into
 * `models.json` is not enough: measured 2026-08-24, a published slot carrying an OAuth credential
 * fails with `No API key found`, because Pi honours an OAuth credential only for a provider
 * definition that declares the flow, and a `models.json` entry declares none. The child may then
 * fall through to Pi's own first-available provider — a different account or vendor, silently.
 *
 * The Cursor slots already solve this, and the shape is the answer for every OAuth family:
 * publish the slot against a route the parent serves on `127.0.0.1`, with a deliberately
 * non-secret placeholder as its `apiKey`. Pi sees a credential and admits the provider; the child
 * authenticates to this machine with a string worth nothing; the parent swaps in the real token
 * and adds whatever the family needs. The credential never leaves the parent.
 *
 * ## What lives here
 *
 * Only the decisions — routing, admission, and the exact shape of the upstream request. No
 * socket, no credential store, no file. That keeps the security-relevant rules (the placeholder is
 * never forwarded, an unknown caller is never served, a token never reaches a diagnostic) testable
 * exhaustively and without a network.
 */

/**
 * The `apiKey` published into `models.json` for a proxied slot.
 *
 * Deliberately not a secret and deliberately recognisable: it exists so Pi will admit the
 * provider, and so this proxy can tell "a child we published a route for" from anything else that
 * found the port. It is also the admission token — see {@link admitRequest}.
 */
export const PROXY_PLACEHOLDER_KEY = "pi-multi-account-proxy";

/**
 * The `apiKey` published for a **Codex** slot.
 *
 * Pi's Codex API does not merely pass the key along: before any request it splits it on `.`,
 * base64-decodes the middle segment and reads `chatgpt_account_id` out of it, failing with
 * "Failed to extract accountId from token" if that does not work (measured 2026-08-24 against a
 * real `pi -p --no-extensions` child). So the placeholder for that family has to be shaped like a
 * token even though it is not one.
 *
 * Nothing here is secret and nothing here is real: the algorithm is `none`, there is no signature,
 * and the account id is the placeholder string rather than the user's — the proxy replaces both
 * the authorization header and the account id with the genuine values on the way out, so the
 * published file never carries either.
 */
export const PROXY_PLACEHOLDER_JWT = [
	Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64"),
	Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: PROXY_PLACEHOLDER_KEY },
		}),
	).toString("base64"),
	"",
].join(".");

/** Either published placeholder — neither is a credential, both mark "a child we published for". */
export function isPublishedPlaceholder(value: string | undefined): boolean {
	return value === PROXY_PLACEHOLDER_KEY || value === PROXY_PLACEHOLDER_JWT;
}

export type ProxyFamily = "anthropic" | "codex";

/** Where each family's traffic really goes. */
export const UPSTREAM_BASE: Readonly<Record<ProxyFamily, string>> = Object.freeze({
	anthropic: "https://api.anthropic.com",
	codex: "https://chatgpt.com/backend-api",
});

export interface ProxyRoute {
	slotId: string;
	family: ProxyFamily;
}

export interface ProxyCredential {
	type?: string;
	access?: string;
	key?: string;
	accountId?: string;
}

/**
 * Headers a proxy must never copy from the incoming request to the outgoing one.
 *
 * The hop-by-hop set is per RFC 9110; `host` and `content-length` are recomputed by the client;
 * `authorization`/`x-api-key` are dropped because replacing them is the entire point of this
 * proxy and forwarding the placeholder would authenticate nothing.
 */
const DROPPED_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"host",
	"content-length",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"proxy-authorization",
	"proxy-authenticate",
	"accept-encoding",
]);

/**
 * Split `/slot-id/v1/messages` into the slot and the path to forward.
 *
 * Returns `undefined` for anything that is not that shape, including a path that tries to climb
 * out of its slot. A loopback port is reachable by every process on the machine, so the parsing
 * here is the first of the two gates — the second is {@link admitRequest}.
 */
export function parseProxyPath(
	rawUrl: string,
): { slotId: string; rest: string } | undefined {
	if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return undefined;
	const [pathname] = rawUrl.split("#");
	const separator = pathname.indexOf("/", 1);
	const slotId = decodeURIComponent(
		separator === -1 ? pathname.slice(1) : pathname.slice(1, separator),
	).split("?")[0];
	if (!slotId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slotId)) return undefined;
	const rest = separator === -1 ? "/" : pathname.slice(separator);
	// `..` in any form is refused rather than normalised: there is no legitimate caller that needs
	// it, and normalising is where path-traversal bugs live.
	if (rest.includes("..") || rest.includes("%2e%2e") || rest.includes("%2E%2E")) {
		return undefined;
	}
	return { slotId, rest };
}

/** The credential the caller presented, from either header a Pi provider might use. */
export function presentedCredential(
	headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
	const pick = (name: string) => {
		const value = headers[name];
		const first = Array.isArray(value) ? value[0] : value;
		return typeof first === "string" ? first.trim() : undefined;
	};
	const bearer = pick("authorization");
	if (bearer) return bearer.replace(/^Bearer\s+/i, "").trim();
	return pick("x-api-key");
}

export type Admission =
	| { ok: true; route: ProxyRoute }
	| { ok: false; status: number; message: string };

/**
 * Decide whether to serve a request at all.
 *
 * Two gates, and both matter. The slot has to be one we published — otherwise the port becomes a
 * way to reach any upstream through the user's tokens. And the caller has to present the
 * placeholder — otherwise every process on this machine can spend the user's subscription just by
 * finding the port. The placeholder is not a secret and is not treated as one; it is the marker of
 * "a child Pi launched against a route we published", which is exactly the population this serves.
 */
export function admitRequest(args: {
	rawUrl: string;
	headers: Readonly<Record<string, string | string[] | undefined>>;
	routes: ReadonlyMap<string, ProxyRoute>;
}): Admission & { rest?: string } {
	const parsed = parseProxyPath(args.rawUrl);
	if (!parsed) return { ok: false, status: 404, message: "not a slot route" };
	const route = args.routes.get(parsed.slotId);
	if (!route) return { ok: false, status: 404, message: "unknown slot" };
	if (!isPublishedPlaceholder(presentedCredential(args.headers))) {
		// Never echo what was presented: it may be a real credential belonging to whoever called.
		return { ok: false, status: 401, message: "this route serves published slots only" };
	}
	return { ok: true, route, rest: parsed.rest };
}

export type UpstreamRequest =
	| { ok: true; url: string; headers: Record<string, string> }
	| { ok: false; status: number; message: string };

/**
 * Build the request that actually goes out.
 *
 * The real credential enters here and leaves only in the returned headers — never in a message,
 * because these messages are logged and shown.
 */
export function shapeUpstreamRequest(args: {
	route: ProxyRoute;
	rest: string;
	headers: Readonly<Record<string, string | string[] | undefined>>;
	credential: ProxyCredential | undefined;
}): UpstreamRequest {
	const { route, rest, credential } = args;
	const base = UPSTREAM_BASE[route.family];
	if (!base) return { ok: false, status: 500, message: `no upstream for ${route.family}` };
	if (!credential) {
		return {
			ok: false,
			status: 401,
			message: `no credential held for ${route.slotId} — run /login for that account`,
		};
	}

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(args.headers)) {
		const lower = name.toLowerCase();
		if (DROPPED_HEADERS.has(lower)) continue;
		const first = Array.isArray(value) ? value.join(", ") : value;
		if (typeof first === "string") headers[lower] = first;
	}

	if (credential.type === "api_key" || (!credential.access && credential.key)) {
		const key = credential.key;
		if (!key) {
			return {
				ok: false,
				status: 401,
				message: `no API key held for ${route.slotId} — run /login for that account`,
			};
		}
		if (route.family === "anthropic") headers["x-api-key"] = key;
		else headers.authorization = `Bearer ${key}`;
	} else {
		if (!credential.access) {
			return {
				ok: false,
				status: 401,
				message: `the credential for ${route.slotId} has no access token — run /login for that account`,
			};
		}
		headers.authorization = `Bearer ${credential.access}`;
		if (route.family === "anthropic") {
			// The header Anthropic requires before it will accept a subscription token at all.
			headers["anthropic-beta"] = mergeBeta(headers["anthropic-beta"], "oauth-2025-04-20");
		} else if (route.family === "codex") {
			// Codex routes a subscription request by account. Pi fills this header in from the
			// placeholder it was given, so it must be overwritten here — not defaulted — or the
			// request goes upstream naming an account that does not exist.
			if (credential.accountId) headers["chatgpt-account-id"] = credential.accountId;
			else delete headers["chatgpt-account-id"];
			headers.originator = headers.originator ?? "pi";
		}
	}

	return { ok: true, url: `${base}${rest}`, headers };
}

/** Keep any beta flags the caller asked for, and add ours once. */
function mergeBeta(existing: string | undefined, required: string): string {
	if (!existing) return required;
	const parts = existing
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	if (!parts.includes(required)) parts.push(required);
	return parts.join(",");
}

/** The `apiKey` to publish for a slot of this family. */
export function placeholderKeyFor(family: ProxyFamily): string {
	return family === "codex" ? PROXY_PLACEHOLDER_JWT : PROXY_PLACEHOLDER_KEY;
}

/** The `models.json` route to publish for a slot served by this proxy. */
export function publishedRouteFor(port: number, slotId: string): string {
	return `http://127.0.0.1:${port}/${slotId}`;
}

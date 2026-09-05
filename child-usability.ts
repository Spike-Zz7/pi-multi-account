/**
 * Can an extension-free Pi child actually use this rotation slot?
 *
 * ## Why this exists
 *
 * Pi stores optional startup defaults as `defaultProvider`/`defaultModel` in `settings.json`.
 * They change only when the user explicitly saves a default; ordinary model switches, including
 * extension-driven rotation, do not rewrite them. A bare `pi -p --no-extensions` child launched
 * without an explicit model reads those defaults and tries to run on that slot.
 *
 * A child launched that way does not load this extension, so a slot named `openai-codex-account-4`
 * exists for it only if we published it into Pi's own `models.json`. Publishing the *name*,
 * however, is not the same as publishing a usable route, and the difference is invisible until
 * something fails far away from here.
 *
 * ## What was measured (2026-08-24), not assumed
 *
 * In an isolated agent directory containing one `models.json` provider entry mirroring the
 * built-in Codex definition plus the matching **OAuth** credential under the same key:
 *
 *     pi -p --no-extensions --no-session --model openai-codex-account-4/gpt-5.6-sol …
 *     → exit 1: "No API key found for openai-codex-account-4."
 *
 * The same child, pointed at the **built-in** `openai-codex` provider with its OAuth credential,
 * got past authentication (it reached the network instead of refusing).
 *
 * The reason is in Pi: `checkProviderAuth` honours an OAuth credential only when the *provider
 * definition* declares an OAuth flow. A `models.json` entry declares none, so an OAuth token
 * sitting in `auth.json` under exactly that key is never consulted. An API key is different —
 * it resolves through the credential store and works.
 *
 * ## The three outcomes, and why one of them is a lie we currently tell
 *
 * | slot shape | child outcome |
 * |---|---|
 * | built-in provider (`anthropic`, `openai-codex`, …), any credential | usable — Pi owns the auth flow |
 * | alias slot published with a real or placeholder `apiKey` | usable — Pi sees a credential |
 * | **alias slot with an OAuth credential and no `apiKey`** | **resolves by name, then fails at auth** |
 *
 * The third row is what we do today for Kimi slots, under a comment promising that
 * "extension-free children resolve it". True of the name; false of the credential. The Cursor
 * slots avoid it by publishing a non-secret placeholder that points at a parent-owned local
 * proxy, so the child authenticates to `127.0.0.1` while the real token stays in the parent.
 *
 * This module is deliberately pure: it decides and explains, and it touches no file, no socket
 * and no credential. Wiring and the proxy itself are separate, reviewable pieces — this one can
 * be tested exhaustively without any of them.
 */

/** How a slot's credential is stored, as far as `auth.json` is concerned. */
export type SlotCredentialKind = "oauth" | "api_key" | "none";

export interface SlotChildFacts {
  /** Rotation slot id, e.g. `openai-codex-account-4` or a base provider name. */
  slotId: string;
  /** Credential kind held for this exact slot id. */
  credential: SlotCredentialKind;
  /** True when Pi itself defines this provider (it then owns the OAuth flow). */
  builtin: boolean;
  /** `apiKey` published for this slot in `models.json`, when we published one. */
  publishedApiKey?: string;
  /** `baseUrl` published for this slot in `models.json`, when we published one. */
  publishedBaseUrl?: string;
}

export type ChildUsability =
  /** A bare child can authenticate and run on this slot. */
  | { usable: true; slotId: string; via: "builtin" | "api-key" | "parent-proxy"; note: string }
  /** A bare child cannot use it; `remedy` says what would change that. */
  | { usable: false; slotId: string; reason: string; remedy: string };

/** Loopback-only, so a published route can never send a child off this machine. */
function isLoopback(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    // `URL` reports an IPv6 host bracketed (`[::1]`), so compare against the unwrapped form.
    const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Decide, for one slot, whether an extension-free child can run on it.
 *
 * Order matters: a built-in provider is usable whatever we publish, because Pi resolves it
 * without us. Everything else depends on a credential the child can actually present.
 */
export function classifyChildUsability(facts: SlotChildFacts): ChildUsability {
  const { slotId, credential, builtin, publishedApiKey, publishedBaseUrl } = facts;

  if (builtin) {
    return {
      usable: true,
      slotId,
      via: "builtin",
      note: "Pi defines this provider itself and owns its auth flow, so a bare child resolves it without this extension.",
    };
  }

  if (credential === "api_key") {
    return {
      usable: true,
      slotId,
      via: "api-key",
      note: "The credential is an API key, which Pi resolves through its own credential store for a published provider.",
    };
  }

  if (publishedApiKey) {
    // A published key only helps when the route it authenticates to is ours. Sending a
    // placeholder to a real upstream would authenticate nothing and leak the shape of our
    // routing; a non-loopback base URL here is a configuration error, not a usable slot.
    if (!isLoopback(publishedBaseUrl)) {
      return {
        usable: false,
        slotId,
        reason:
          "A placeholder key is published, but the route does not point at this machine — a placeholder is only meaningful to a proxy the parent owns.",
        remedy: "Publish the slot with a loopback baseUrl served by the parent, or remove the placeholder.",
      };
    }
    return {
      usable: true,
      slotId,
      via: "parent-proxy",
      note: "The child authenticates to a parent-owned loopback route with a non-secret placeholder; the real credential never leaves the parent.",
    };
  }

  if (credential === "oauth") {
    return {
      usable: false,
      slotId,
      reason:
        "The credential is OAuth, and Pi honours OAuth only for a provider definition that declares the flow. A models.json entry declares none, so the token under this key is never consulted — the slot resolves by name and then fails with \"No API key found\".",
      remedy:
        "Publish this slot against a parent-owned loopback proxy with a non-secret placeholder key, the way Cursor slots already work.",
    };
  }

  return {
    usable: false,
    slotId,
    reason: "No credential is held for this slot.",
    remedy: "Log in to this account, or drop the slot from the published registry.",
  };
}

/**
 * The slot a bare child would actually be sent to, given Pi's saved startup default. Returns
 * `undefined` when the default is fine.
 *
 * This turns a silent, far-away failure into something sayable here: when the saved default is
 * not child-usable, a child spawned without an explicit `--model` may fall through to Pi's own
 * first available provider instead.
 */
export function defaultRouteWarning(
  defaultSlotId: string | undefined,
  classify: (slotId: string) => ChildUsability | undefined,
): string | undefined {
  if (!defaultSlotId) return undefined;
  const verdict = classify(defaultSlotId);
  if (!verdict || verdict.usable) return undefined;
  return (
    `Pi records ${defaultSlotId} as the startup default, but an extension-free child cannot use it: ` +
    `${verdict.reason} Such a child may fall back to Pi's own first-available provider. ${verdict.remedy}`
  );
}

/** One line per slot, for `/multi-account status`. Stable order: unusable first, then by id. */
export function describeChildUsability(verdicts: readonly ChildUsability[]): string[] {
  const ordered = [...verdicts].sort(
    (a, b) => Number(a.usable) - Number(b.usable) || a.slotId.localeCompare(b.slotId),
  );
  return ordered.map((verdict) =>
    verdict.usable
      ? `  ${verdict.slotId} — usable by a bare child (${verdict.via})`
      : `  ${verdict.slotId} — NOT usable by a bare child: ${verdict.reason}`,
  );
}

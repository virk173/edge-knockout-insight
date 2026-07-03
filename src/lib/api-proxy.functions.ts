import { createServerFn } from "@tanstack/react-start";

/**
 * api-proxy
 *
 * Server-side proxy so third-party API keys never reach the browser.
 * Keys are read from server-only env vars:
 *   - APIFOOTBALL_KEY  (api-sports.io / API-Football)   -> sent as x-apisports-key header
 *   - STATSAPI_KEY     (thestatsapi.com / lineups+odds) -> sent as Authorization: Bearer header
 *
 * The browser documents these as VITE_APIFOOTBALL_KEY / VITE_STATSAPI_KEY for
 * reference, but the actual values stay server-side here.
 *
 * Input:  { provider: "apifootball" | "statsapi", url: string }
 * Output: { ok, status, statusText, json } or { ok: false, error }
 */

type Provider = "apifootball" | "statsapi";

interface ApiFetchInput {
  provider: Provider;
  url: string;
}

// Exact-origin allowlist. A naive prefix check (`url.startsWith(...)`) is
// bypassable via hostnames like "v3.football.api-sports.io.evil.com" — the
// server would then attach the API key header to an attacker-controlled host.
// Parse the URL and compare origin exactly; statsapi additionally requires the
// /api path prefix its base URL carries.
const ALLOWED_ORIGIN: Record<Provider, { origin: string; pathPrefix: string }> = {
  apifootball: { origin: "https://v3.football.api-sports.io", pathPrefix: "/" },
  statsapi: { origin: "https://api.thestatsapi.com", pathPrefix: "/api" },
};

export function validateInput(input: unknown): ApiFetchInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("Request body must be an object.");
  }
  const { provider, url } = input as Record<string, unknown>;
  if (provider !== "apifootball" && provider !== "statsapi") {
    throw new Error("`provider` must be 'apifootball' or 'statsapi'.");
  }
  if (typeof url !== "string") {
    throw new Error("`url` is missing or not an allowed endpoint.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("`url` is missing or not an allowed endpoint.");
  }
  const allowed = ALLOWED_ORIGIN[provider as Provider];
  if (parsed.origin !== allowed.origin || !parsed.pathname.startsWith(allowed.pathPrefix)) {
    throw new Error("`url` is missing or not an allowed endpoint.");
  }
  return { provider: provider as Provider, url };
}

export const apiFetch = createServerFn({ method: "POST" })
  .inputValidator(validateInput)
  .handler(async ({ data }) => {
    if (data.provider === "statsapi") {
      const key = process.env.STATSAPI_KEY;
      if (!key) {
        return {
          ok: false as const,
          status: 0,
          statusText: "STATSAPI_KEY is not configured on the server.",
          json: null,
        };
      }
      // TheStatsAPI authenticates via a Bearer token in the Authorization header.
      let response: Response;
      try {
        response = await fetch(data.url, {
          headers: { Authorization: `Bearer ${key}` },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false as const, status: 0, statusText: msg, json: null };
      }
      const json = await response.json().catch(() => null);
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        retryAfter: response.headers.get("retry-after"),
        json,
      };
    }

    // ---- API-Football (header auth) ----
    const key = process.env.APIFOOTBALL_KEY;
    if (!key) {
      return {
        ok: false as const,
        status: 0,
        statusText: "APIFOOTBALL_KEY is not configured on the server.",
        json: null,
      };
    }

    const headers: Record<string, string> = { "x-apisports-key": key };

    let response: Response;
    try {
      response = await fetch(data.url, { headers });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, status: 0, statusText: msg, json: null };
    }

    const json = await response.json().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      retryAfter: response.headers.get("retry-after"),
      json,
    };
  });

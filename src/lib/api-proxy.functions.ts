import { createServerFn } from "@tanstack/react-start";

/**
 * api-proxy
 *
 * Server-side proxy so third-party API keys never reach the browser.
 * Keys are read from server-only env vars:
 *   - APIFOOTBALL_KEY  (api-sports.io / API-Football)  -> sent as header
 *   - ODDSPAPI_KEY     (oddspapi.io / Pinnacle odds)   -> appended as ?apiKey=
 *
 * The browser documents these as VITE_APIFOOTBALL_KEY / VITE_ODDSPAPI_KEY for
 * reference, but the actual values stay server-side here.
 *
 * Input:  { provider: "apifootball" | "oddspapi", url: string }
 * Output: { ok, status, statusText, json } or { ok: false, error }
 */

type Provider = "apifootball" | "oddspapi";

interface ApiFetchInput {
  provider: Provider;
  url: string;
}

const ALLOWED_PREFIX: Record<Provider, string> = {
  apifootball: "https://v3.football.api-sports.io",
  oddspapi: "https://api.oddspapi.io",
};

function validateInput(input: unknown): ApiFetchInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("Request body must be an object.");
  }
  const { provider, url } = input as Record<string, unknown>;
  if (provider !== "apifootball" && provider !== "oddspapi") {
    throw new Error("`provider` must be 'apifootball' or 'oddspapi'.");
  }
  if (typeof url !== "string" || !url.startsWith(ALLOWED_PREFIX[provider as Provider])) {
    throw new Error("`url` is missing or not an allowed endpoint.");
  }
  return { provider: provider as Provider, url };
}

export const apiFetch = createServerFn({ method: "POST" })
  .inputValidator(validateInput)
  .handler(async ({ data }) => {
    if (data.provider === "oddspapi") {
      const key = process.env.ODDSPAPI_KEY;
      if (!key) {
        return {
          ok: false as const,
          status: 0,
          statusText: "ODDSPAPI_KEY is not configured on the server.",
          json: null,
        };
      }
      // OddsPapi authenticates via an `apiKey` query parameter.
      const sep = data.url.includes("?") ? "&" : "?";
      const finalUrl = `${data.url}${sep}apiKey=${encodeURIComponent(key)}`;

      let response: Response;
      try {
        response = await fetch(finalUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false as const, status: 0, statusText: msg, json: null };
      }
      const json = await response.json().catch(() => null);
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
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
      json,
    };
  });

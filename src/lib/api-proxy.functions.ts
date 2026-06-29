import { createServerFn } from "@tanstack/react-start";

/**
 * api-proxy
 *
 * Server-side proxy for API-Football so its API key never reaches the browser.
 * The key is read from a server-only env var:
 *   - APIFOOTBALL_KEY  (api-sports.io / API-Football)
 *
 * Input:  { provider: "apifootball", url: string }
 * Output: { ok, status, statusText, json } or { ok: false, error }
 */

type Provider = "apifootball";

interface ApiFetchInput {
  provider: Provider;
  url: string;
}

const ALLOWED_PREFIX: Record<Provider, string> = {
  apifootball: "https://v3.football.api-sports.io",
};

function validateInput(input: unknown): ApiFetchInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("Request body must be an object.");
  }
  const { provider, url } = input as Record<string, unknown>;
  if (provider !== "apifootball") {
    throw new Error("`provider` must be 'apifootball'.");
  }
  if (typeof url !== "string" || !url.startsWith(ALLOWED_PREFIX[provider])) {
    throw new Error("`url` is missing or not an allowed endpoint.");
  }
  return { provider, url };
}

export const apiFetch = createServerFn({ method: "POST" })
  .inputValidator(validateInput)
  .handler(async ({ data }) => {
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

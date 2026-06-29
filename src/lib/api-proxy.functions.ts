import { createServerFn } from "@tanstack/react-start";

/**
 * api-proxy
 *
 * Server-side proxy for the two third-party sports data providers so their
 * API keys never reach the browser. Keys are read from server-only env vars:
 *   - APIFOOTBALL_KEY  (api-sports.io / API-Football)
 *   - STATSAPI_KEY     (thestatsapi.com)
 *
 * Input:  { provider: "apifootball" | "statsapi", url: string }
 * Output: { ok, status, statusText, json } or { ok: false, error }
 */

type Provider = "apifootball" | "statsapi";

interface ApiFetchInput {
  provider: Provider;
  url: string;
}

const ALLOWED_PREFIX: Record<Provider, string> = {
  apifootball: "https://v3.football.api-sports.io",
  statsapi: "https://api.thestatsapi.com",
};

function validateInput(input: unknown): ApiFetchInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("Request body must be an object.");
  }
  const { provider, url } = input as Record<string, unknown>;
  if (provider !== "apifootball" && provider !== "statsapi") {
    throw new Error("`provider` must be 'apifootball' or 'statsapi'.");
  }
  if (typeof url !== "string" || !url.startsWith(ALLOWED_PREFIX[provider])) {
    throw new Error("`url` is missing or not an allowed endpoint.");
  }
  return { provider, url };
}

export const apiFetch = createServerFn({ method: "POST" })
  .inputValidator(validateInput)
  .handler(async ({ data }) => {
    const key =
      data.provider === "apifootball"
        ? process.env.APIFOOTBALL_KEY
        : process.env.STATSAPI_KEY;

    if (!key) {
      const name =
        data.provider === "apifootball" ? "APIFOOTBALL_KEY" : "STATSAPI_KEY";
      return {
        ok: false as const,
        status: 0,
        statusText: `${name} is not configured on the server.`,
        json: null,
      };
    }

    const headers: Record<string, string> =
      data.provider === "apifootball"
        ? { "x-apisports-key": key }
        : { Authorization: `Bearer ${key}` };

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

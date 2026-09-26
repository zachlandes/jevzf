// Spend accounting adapted from herdr-find 4736dd5 (Apache-2.0)
import { APIError, RateLimitError, TypeSafeClient } from "@typesafe-ai/sdk";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const PINNED_MODEL = "jev-1.13.0";
// Output tokens are free for this model
export const JEV_PRICE = {
  model: PINNED_MODEL,
  usd_per_million_input_tokens: 0.042,
  source: "https://docs.typesafe.ai/models.md",
  checked: "2026-09-25"
};

// Reserve the documented model context ceiling, not an empirical bytes/token ratio
export const MAX_INPUT_TOKENS = 65536;
// For estimates shown before a search, the measured rate rather than the reservation
export const ESTIMATE_TOKENS_PER_BYTE = 0.25;

const RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504]);

export class SpendCapError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpendCapError";
  }
}

export class ServiceError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

export const usdFor = (tokens, price = JEV_PRICE) => (tokens * price.usd_per_million_input_tokens) / 1e6;

export const estimateUsd = (bytes) => usdFor(bytes * ESTIMATE_TOKENS_PER_BYTE);

// Only a loopback address may stand in for TypeSafe, so a test's stand-in can never be a real host
// the key would be sent to
export function jevEndpoint(env = process.env) {
  const wanted = env.JEVZF_JEV_ENDPOINT;
  if (!wanted) return JEV_ENDPOINT;
  try {
    const url = new URL(wanted);
    if (url.protocol === "http:" && !url.username && !url.password && ["127.0.0.1", "[::1]"].includes(url.hostname)) return url.href;
  } catch { /* Report a generic error without echoing the supplied URL */ }
  throw new ServiceError("JEVZF_JEV_ENDPOINT must be a numeric HTTP loopback URL");
}

// A spend cap enforced before every send: an attempt reserves its worst case first and is refused
// if the reservation would pass the cap. A response books its billed tokens; an attempt that may
// have reached the service without a usable answer books its reservation, since it may be billed.
export function createSpendBudget({ capUsd, spentUsd = 0, price = JEV_PRICE, onChange = () => {} }) {
  if (!(Number.isFinite(capUsd) && capUsd > 0)) throw new TypeError("a spend cap in USD above zero is required");
  let booked = spentUsd;
  let reserved = 0;
  let billedTokens = 0;
  let unknownAttempts = 0;
  return {
    capUsd,
    reserve(tokens) {
      const usd = usdFor(tokens, price);
      if (booked + reserved + usd > capUsd) throw new SpendCapError("spend cap reached");
      reserved += usd;
      onChange(booked + reserved);
      let open = true;
      return {
        settle(billed) {
          if (!open) return;
          open = false;
          reserved -= usd;
          if (Number.isInteger(billed) && billed >= 0) {
            booked += usdFor(billed, price);
            billedTokens += billed;
          } else {
            booked += usd;
            unknownAttempts += 1;
          }
          onChange(booked + reserved);
        },
        release() {
          if (!open) return;
          open = false;
          reserved -= usd;
          onChange(booked + reserved);
        }
      };
    },
    // What is committed so far, counting requests still in flight at their reservation
    committedUsd: () => booked + reserved,
    summary() {
      return { cap_usd: capUsd, committed_usd: booked + reserved, billed_input_tokens: billedTokens, attempts_booked_at_reservation: unknownAttempts };
    }
  };
}

export function createResponder({ key, budget, assertSafe, fetchImpl = globalThis.fetch, endpoint = JEV_ENDPOINT, timeoutMs = 30000, maxRetries = 2 }) {
  if (!key?.authorization || !budget || !assertSafe) throw new TypeError("key, spend budget and never-send check are required");
  return async (request) => {
    if (request.model !== PINNED_MODEL) throw new ServiceError("request model is not pinned");
    const abort = new AbortController();
    let localError;
    const local = (fn) => {
      try { return fn(); }
      catch (error) { localError = error; abort.abort(); throw error; }
    };
    const client = new TypeSafeClient({
      apiKey: key.authorization.slice("Bearer ".length),
      baseURL: new URL(endpoint).origin,
      defaultModel: PINNED_MODEL,
      // Explicit settings prevent SDK environment defaults from leaking data or keys
      logLevel: "off",
      timeout: timeoutMs,
      retry: { maxRetries, httpStatuses: RETRYABLE_STATUSES, respectRetryAfter: true },
      fetch: async (_url, init) => {
        local(() => assertSafe(JSON.parse(init.body)));
        const ticket = local(() => budget.reserve(MAX_INPUT_TOKENS));
        let response;
        try {
          // Surface redirects as non-retryable HTTP errors without following them
          response = await fetchImpl(endpoint, { ...init, redirect: "manual" });
        } catch (error) {
          local(() => ticket.settle(null));
          throw error;
        }
        if (!response.ok) {
          local(() => response.status >= 500 ? ticket.settle(null) : ticket.release());
        } else {
          let json;
          try { json = await response.clone().json(); }
          catch { /* An unreadable response may still have been billed */ }
          local(() => ticket.settle(json?.usage?.input_tokens));
        }
        return response;
      }
    });
    let json;
    try {
      json = await client.systemOne(request, { signal: abort.signal });
    } catch (error) {
      if (localError) throw localError;
      if (error instanceof APIError) {
        if (error.status === 429 || error.status === 529) {
          // The SDK exposes its Retry-After parser through RateLimitError, including HTTP dates
          const delay = new RateLimitError(error.status, undefined, error.headers).retryAfterMs;
          const after = Number.isFinite(delay) ? `${Math.ceil(delay / 1000)} seconds` : "not supplied";
          throw new ServiceError(`TypeSafe returned HTTP ${error.status}; stopped; retry-after: ${after}`, { status: error.status });
        }
        throw new ServiceError(`TypeSafe returned HTTP ${error.status}`, { status: error.status });
      }
      throw new ServiceError("TypeSafe request failed; no input or key logged");
    }
    if (json?.model !== PINNED_MODEL) throw new ServiceError("TypeSafe answered with an unexpected model");
    return json;
  };
}

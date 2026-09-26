import { createHash } from "node:crypto";
import { createResponder, createSpendBudget, estimateUsd, MAX_INPUT_TOKENS, PINNED_MODEL, usdFor, SpendCapError } from "./jev.mjs";
import { makeMeaningQuestion, MEANING_PROMPT } from "./prompts.mjs";
import { RedactionError } from "./redaction.mjs";
import { withState } from "../state.mjs";

// Batching, request-local ids and Noul relevance adapted from herdr-find 4736dd5
export const MEANING = Object.freeze({ floor: 0.58, batch: 16, batchBytes: 24000, maxItems: 5000, maxQueryChars: 400 });
export class SearchError extends Error {}

export function batchesOf(lines) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line);
    if (current.length && (current.length >= MEANING.batch || bytes + size > MEANING.batchBytes)) {
      batches.push(current); current = []; bytes = 0;
    }
    current.push(line); bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function buildMeaningRequest(query, lines, redactor) {
  const ids = lines.map((_, index) => `i${index + 1}`);
  const request = {
    state: { search: query, items: Object.fromEntries(lines.map((line, i) => [ids[i], line])) },
    model: PINNED_MODEL,
    questions: Object.fromEntries(ids.map((id) => [id, makeMeaningQuestion(id)]))
  };
  const redact = (value) => {
    if (typeof value === "string") return redactor.redact(value);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)]));
  };
  request.state = redact(request.state);
  request.questions = redact(request.questions);
  assertCleanRequest(request, redactor);
  return request;
}

function assertCleanRequest(request, redactor) {
  const clean = (value) => typeof value === "string" ? redactor.clean(value) : Object.entries(value).every(([key, child]) => redactor.clean(key) && clean(child));
  if (!clean(request) || !redactor.clean(JSON.stringify(request))) throw new RedactionError("redaction check refused a request; nothing was sent");
}

function validate(response, request) {
  if (!Number.isInteger(response?.usage?.input_tokens) || response.usage.input_tokens < 0 || response.usage.input_tokens > MAX_INPUT_TOKENS) throw new SearchError("invalid TypeSafe token count");
  for (const id of Object.keys(request.questions)) {
    const answer = response?.answers?.[id];
    if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new SearchError("invalid TypeSafe relevance response");
  }
  return response;
}

export async function searchByMeaning({ query, lines, key, redactor, config, endpoint, notice = () => {}, fetchImpl, retry = {}, lockTimeoutMs }) {
  if (!query.trim() || query.length > MEANING.maxQueryChars) throw new SearchError("query must contain 1–400 characters");
  const unique = [...new Set(lines.filter((line) => line.trim()))].sort();
  if (unique.length > MEANING.maxItems) throw new SearchError("input exceeds 5000 distinct nonblank lines; narrow the input first");
  if (unique.some((line) => Buffer.byteLength(line) > MEANING.batchBytes)) throw new SearchError("a line exceeds 24000 UTF-8 bytes; shorten it first");
  if (!unique.length) return { lines: [], cached: false, spend: 0 };
  const batches = batchesOf(unique);
  // Check every batch before spending on any of them
  const requests = batches.map((batch) => buildMeaningRequest(query, batch, redactor));
  const hash = createHash("sha256").update(JSON.stringify({ version: 1, prompt: MEANING_PROMPT, model: PINNED_MODEL, endpoint, query, lines: unique, redaction: redactor.fingerprint })).digest("hex");
  return withState(config.state_dir, async (state) => {
    const cached = state.get(hash);
    const ranked = (scores) => unique.map((line, i) => ({ line, p: scores[i] })).filter((e) => e.p >= MEANING.floor).sort((a, b) => b.p - a.p).map((e) => e.line);
    if (cached?.length === unique.length) {
      notice("cache hit; cost $0");
      return { lines: ranked(cached), cached: true, spend: 0 };
    }
    const available = Math.max(0, Math.min(config.search_cap_usd, config.daily_cap_usd - state.spent));
    const estimate = requests.reduce((sum, request) => sum + estimateUsd(Buffer.byteLength(JSON.stringify(request))), 0);
    notice(`about $${estimate.toFixed(6)}; search cap $${config.search_cap_usd}; rolling 24h cap $${config.daily_cap_usd}; available $${available.toFixed(6)}`);
    // The last request still has to reserve its full worst case, so a search that cannot finish is
    // refused before it spends anything
    if (estimate + usdFor(MAX_INPUT_TOKENS) > available) {
      const binding = config.search_cap_usd <= config.daily_cap_usd - state.spent ? "raise search_cap_usd" : "raise daily_cap_usd or wait for the rolling 24h cap";
      throw new SpendCapError(`estimated cost plus one request reservation ($${usdFor(MAX_INPUT_TOKENS)}) exceeds the available $${available.toFixed(6)}; ${binding} or narrow the input; nothing sent`);
    }
    const budget = createSpendBudget({ capUsd: available, onChange: (usd) => state.book(usd) });
    const responder = createResponder({ key, budget, endpoint, fetchImpl, assertSafe: (request) => assertCleanRequest(request, redactor), maxRetries: retry.maxRetries });
    const scores = [];
    try {
      for (const request of requests) {
        const response = validate(await responder(request), request);
        scores.push(...Object.keys(request.questions).map((id) => response.answers[id].noul));
      }
      state.put(hash, scores);
      return { lines: ranked(scores), cached: false, spend: budget.committedUsd(), tokens: budget.summary().billed_input_tokens };
    } finally {
      const summary = budget.summary();
      notice(`booked $${summary.committed_usd.toFixed(9)}; ${summary.billed_input_tokens} billed input tokens; ${summary.attempts_booked_at_reservation} uncertain attempts`);
    }
  }, { lockTimeoutMs, notice });
}

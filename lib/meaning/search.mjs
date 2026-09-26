import { stripVTControlCharacters } from "node:util";
import { estimateUsd, MAX_INPUT_TOKENS, PINNED_MODEL, SpendCapError, ServiceError } from "./jev.mjs";
import { makeMeaningQuestion, MEANING_PROMPT } from "./prompts.mjs";
import { RedactionError } from "./redaction.mjs";
import { answerCache } from "../cache.mjs";

// Concurrency matches the default ceiling: USD 0.02 holds seven full-context reservations at once
export const MEANING = Object.freeze({ floor: 0.58, batch: 16, batchBytes: 24000, maxItems: 5000, maxQueryChars: 400, concurrency: 8 });
export class SearchError extends Error {}

export function batchesOf(lines) {
  const batches = [];
  let current = [], bytes = 0;
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

export function assertCleanRequest(body, redactor) {
  const clean = (value) => {
    if (typeof value === "string") return redactor.clean(value);
    if (value === null || typeof value !== "object") return true;
    return Object.entries(value).every(([key, child]) => redactor.clean(key) && clean(child));
  };
  let request;
  try { request = JSON.parse(body); }
  catch { throw new SearchError("request must serialize as JSON"); }
  if (!clean(request) || !redactor.allowed(body)) throw new RedactionError("never-send check refused a request; nothing was sent");
}

export function buildMeaningRequest(query, lines, redactor) {
  const ids = lines.map((_, index) => `i${index + 1}`);
  const request = {
    state: { search: query, items: Object.fromEntries(lines.map((line, i) => [ids[i], line])) },
    model: PINNED_MODEL,
    questions: Object.fromEntries(ids.map((id) => [id, makeMeaningQuestion(id)]))
  };
  assertCleanRequest(JSON.stringify(request), redactor);
  return request;
}

function prepare({ jev, query, items, pickLine = false }) {
  if (typeof query !== "string" || !query.trim() || query.length > MEANING.maxQueryChars) throw new SearchError("query must contain 1–400 characters");
  if (!Array.isArray(items)) throw new SearchError("items must be an array of strings or objects with text");
  const rows = [];
  let bytes = 0, changed = 0;
  for (const [index, item] of items.entries()) {
    const text = typeof item === "string" ? item : item?.text;
    if (typeof text !== "string") throw new SearchError("each item needs text");
    bytes += Buffer.byteLength(text);
    const lines = pickLine ? text.split(/\r?\n/) : [text];
    for (const [lineIndex, line] of lines.entries()) {
      if (!line.trim()) continue;
      const plain = stripVTControlCharacters(line);
      const sent = jev.redactor.redact(plain);
      if (sent !== plain) changed++;
      if (Buffer.byteLength(sent) > MEANING.batchBytes) throw new SearchError("an item exceeds 24000 UTF-8 bytes; shorten it first");
      rows.push({ item, index, line, lineIndex, sent });
    }
  }
  if (bytes > 10 * 1024 * 1024) throw new SearchError("input exceeds 10 MiB; narrow the input first");
  const unique = [...new Set(rows.map((row) => row.sent))];
  if (unique.length > MEANING.maxItems) throw new SearchError("input exceeds 5000 distinct nonblank items; narrow the input first");
  const sentQuery = jev.redactor.redact(stripVTControlCharacters(query));
  // Validate all input before sending any batch, including items already in the cache
  const requests = batchesOf(unique).map((batch) => buildMeaningRequest(sentQuery, batch, jev.redactor));
  return { rows, unique, requests, sentQuery, changed };
}

export function estimateSearch(options) {
  const prepared = prepare(options);
  return {
    lines: prepared.rows.length,
    distinct: prepared.unique.length,
    changed: prepared.changed,
    estimatedUsd: prepared.requests.reduce((sum, request) => sum + estimateUsd(Buffer.byteLength(JSON.stringify(request))), 0),
    perSearchUsd: Math.min(options.capUsd ?? Infinity, options.jev.config.spend.perSearchUsd),
    perDayUsd: options.jev.config.spend.perDayUsd
  };
}

function validate(response, request) {
  if (!Number.isInteger(response?.usage?.input_tokens) || response.usage.input_tokens < 0 || response.usage.input_tokens > MAX_INPUT_TOKENS) throw new SearchError("invalid TypeSafe token count");
  for (const id of Object.keys(request.questions)) {
    const answer = response?.answers?.[id];
    if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new SearchError("invalid TypeSafe relevance response");
  }
  return response;
}

export async function searchByMeaning({ jev, query, items, floor = MEANING.floor, closest = 0, pickLine = false, capUsd, noCache = false, onFound = () => {}, onProgress = () => {}, signal }) {
  if (!Number.isFinite(floor) || floor < 0 || floor > 1 || !Number.isInteger(closest) || closest < 0) throw new SearchError("floor must be between 0 and 1; closest must be a nonnegative integer");
  const { rows, unique, sentQuery } = prepare({ jev, query, items, pickLine });
  const cache = answerCache({ ...jev.config, scope: { model: jev.config.model, provider: jev.config.endpoint, prompt: MEANING_PROMPT, neverSend: jev.redactor.fingerprint, query: sentQuery }, enabled: !noCache, notice: jev.notice, time: jev.time });
  const scores = new Map();
  for (const text of unique) {
    const score = cache.get(text);
    if (score !== undefined) scores.set(text, score);
  }
  const cachedCount = scores.size;
  const bySent = Map.groupBy(rows, (row) => row.sent);
  const missing = unique.filter((text) => !scores.has(text));
  const run = jev.run({ capUsd });
  const batches = batchesOf(missing);
  // A fatal error in one batch stops the others instead of letting them spend on a lost search
  const halt = new AbortController();
  const stop = signal ? AbortSignal.any([signal, halt.signal]) : halt.signal;
  let next = 0, stopped = false, failed = 0, failure;
  const worker = async () => {
    while (!stopped && next < batches.length) {
      stop.throwIfAborted();
      const batch = batches[next++];
      const request = buildMeaningRequest(sentQuery, batch, jev.redactor);
      let response;
      try { response = validate(await run.ask(request, { signal: stop }), request); }
      catch (error) {
        if (stop.aborted) throw stop.reason;
        if (error instanceof SpendCapError) { stopped = true; return; }
        if (!(error instanceof ServiceError || error instanceof SearchError)) throw error;
        failure = error; failed += batch.length;
        continue;
      }
      const judged = batch.map((text, i) => [text, response.answers[`i${i + 1}`].noul]);
      for (const [text, p] of judged) scores.set(text, p);
      await cache.put(judged);
      for (const [text, p] of judged) {
        if (p >= floor) for (const row of bySent.get(text)) onFound({ ...row, p });
      }
      onProgress({ judged: scores.size, total: unique.length, cached: cachedCount, spend: run.summary().committed_usd });
    }
  };
  try {
    const workers = Array.from({ length: Math.min(MEANING.concurrency, batches.length) }, () => worker().catch((error) => {
      halt.abort(error);
      throw error;
    }));
    const outcomes = await Promise.allSettled(workers);
    if (signal?.aborted) throw signal.reason;
    const fatal = outcomes.find((outcome) => outcome.status === "rejected");
    if (fatal) throw fatal.reason;
  } finally { await run.close(); }
  if (failure && !scores.size) throw failure;
  if (stopped && !scores.size && run.summary().attempts_booked_at_reservation > 0) throw new ServiceError("every request failed before the spend ceiling stopped retries");
  const ranked = rows.filter((row) => scores.has(row.sent)).map((row) => ({ item: row.item, index: row.index, line: row.line, lineIndex: row.lineIndex, p: scores.get(row.sent) })).sort((a, b) => b.p - a.p || a.index - b.index || a.lineIndex - b.lineIndex);
  const selected = pickLine ? ranked.filter((row, i) => ranked.findIndex((other) => other.index === row.index) === i) : ranked;
  let matches = selected.filter((row) => row.p >= floor);
  const fallback = !matches.length && closest > 0;
  if (fallback) matches = selected.slice(0, closest);
  const unjudged = rows.filter((row) => !scores.has(row.sent)).length;
  if (stopped) jev.notice(`spend ceiling reached; ${unjudged} lines unjudged (input order)`);
  if (failed) jev.notice(`${failed} distinct items failed; returning the successful judgments`);
  return { matches, lines: matches.map((row) => row.line), cached: missing.length === 0, cachedCount, spend: run.summary().committed_usd, tokens: run.summary().billed_input_tokens, stopped, unjudged, failed, fallback };
}

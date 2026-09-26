import { stripVTControlCharacters } from "node:util";
import { estimateUsd, MAX_INPUT_TOKENS, PINNED_MODEL, privateKeyLines, SpendCapError, ServiceError, usdFor } from "decision-gate";
import { makeMeaningQuestion, MEANING_PROMPT } from "./prompts.mjs";

export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const MEANING = Object.freeze({ floor: 0.58, batch: 16, batchBytes: 24000, maxItems: 5000, maxQueryChars: 400 });
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

export function buildMeaningRequest(query, lines, redactor) {
  const ids = lines.map((_, index) => `i${index + 1}`);
  const request = {
    state: { search: query, items: Object.fromEntries(lines.map((line, i) => [ids[i], line])) },
    model: PINNED_MODEL,
    questions: Object.fromEntries(ids.map((id) => [id, makeMeaningQuestion(id)]))
  };
  redactor.check(JSON.stringify(request));
  return request;
}

function prepare({ jev, query, items, pickLine = false }) {
  if (typeof query !== "string" || !query.trim() || query.length > MEANING.maxQueryChars) throw new SearchError("query must contain 1–400 characters");
  if (!Array.isArray(items)) throw new SearchError("items must be an array of strings or objects with text");
  const rows = [];
  let bytes = 0, changed = 0;
  const lines = [];
  for (const [index, item] of items.entries()) {
    const text = typeof item === "string" ? item : item?.text;
    if (typeof text !== "string") throw new SearchError("each item needs text");
    bytes += Buffer.byteLength(text);
    for (const [lineIndex, line] of (pickLine ? text.split(/\r?\n/) : [text]).entries()) lines.push({ item, index, line, lineIndex, plain: stripVTControlCharacters(line) });
  }
  // A private key piped as separate lines is only recognisable across them
  const keyLines = privateKeyLines(lines.map((entry) => entry.plain));
  for (const { item, index, line, lineIndex, plain } of lines) {
    if (!line.trim()) continue;
    const sent = jev.redactor.redact(keyLines.get(plain) ?? plain);
    if (sent !== plain) changed++;
    if (Buffer.byteLength(sent) > MEANING.batchBytes) throw new SearchError("an item exceeds 24000 UTF-8 bytes; shorten it first");
    rows.push({ item, index, line, lineIndex, sent });
  }
  if (bytes > MAX_INPUT_BYTES) throw new SearchError(`input exceeds ${MAX_INPUT_BYTES / 1024 ** 2} MiB; narrow the input first`);
  const unique = [...new Set(rows.map((row) => row.sent))];
  if (unique.length > MEANING.maxItems) throw new SearchError("input exceeds 5000 distinct nonblank items; narrow the input first");
  const sentQuery = jev.redactor.redact(stripVTControlCharacters(query));
  // Validate all input before sending any batch, including items already in the cache
  for (const batch of batchesOf(unique)) buildMeaningRequest(sentQuery, batch, jev.redactor);
  return { rows, unique, sentQuery, changed };
}

const cacheFor = (jev, sentQuery, noCache, notice = jev.notice) => jev.cache({ scope: { prompt: MEANING_PROMPT, query: sentQuery }, enabled: !noCache, notice });

export function estimateSearch(options) {
  const { rows, unique, sentQuery, changed } = prepare(options);
  // The search itself reports an unavailable cache, so the estimate treats one as empty quietly
  const cache = cacheFor(options.jev, sentQuery, options.noCache, () => {});
  const missing = new Set(unique.filter((text) => cache.get(text) === undefined));
  return {
    lines: rows.length,
    distinct: unique.length,
    cachedLines: rows.filter((row) => !missing.has(row.sent)).length,
    changed,
    estimatedUsd: batchesOf([...missing]).reduce((sum, batch) => sum + estimateUsd(Buffer.byteLength(JSON.stringify(buildMeaningRequest(sentQuery, batch, options.jev.redactor)))), 0),
    perSearchUsd: Math.min(options.capUsd ?? Infinity, options.jev.config.spend.perRunUsd),
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
  const cache = cacheFor(jev, sentQuery, noCache);
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
        // A rejected key rejects every batch, so the other workers must not send theirs
        if (error.status === 401 || error.status === 403) throw error;
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
    // decision-gate owns how many requests the account may have in flight; more workers would only queue
    const workers = Array.from({ length: Math.min(jev.config.limits.inFlight, batches.length) }, () => worker().catch((error) => {
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
  const ceiling = run.summary().ceiling === "day" ? "today's spend ceiling" : "this search's spend ceiling";
  // Nothing judged and nothing sent is a refusal, not a search that found nothing
  if (stopped && !scores.size) throw new SpendCapError(`${ceiling} cannot cover one request, which reserves USD ${usdFor(MAX_INPUT_TOKENS).toFixed(4)}; nothing was sent`);
  const ranked = rows.filter((row) => scores.has(row.sent)).map((row) => ({ item: row.item, index: row.index, line: row.line, lineIndex: row.lineIndex, p: scores.get(row.sent) })).sort((a, b) => b.p - a.p || a.index - b.index || a.lineIndex - b.lineIndex);
  const selected = pickLine ? ranked.filter((row, i) => ranked.findIndex((other) => other.index === row.index) === i) : ranked;
  let matches = selected.filter((row) => row.p >= floor);
  const fallback = !matches.length && closest > 0;
  if (fallback) matches = selected.slice(0, closest);
  const unjudged = rows.filter((row) => !scores.has(row.sent)).length;
  if (stopped) jev.notice(`stopped at ${ceiling}; ${unjudged} ${unjudged === 1 ? "line" : "lines"} unjudged (input order), results are from the lines before them`);
  if (failed) jev.notice(`${failed} distinct ${failed === 1 ? "item" : "items"} failed; returning the successful judgments`);
  return { matches, lines: matches.map((row) => row.line), cached: missing.length === 0, cachedCount, spend: run.summary().committed_usd, tokens: run.summary().billed_input_tokens, stopped, unjudged, failed, fallback };
}

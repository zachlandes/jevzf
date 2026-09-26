import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PINNED_MODEL, MAX_INPUT_TOKENS, usdFor } from "decision-gate";
import { openJev, searchByMeaning, estimateSearch } from "../lib/core.mjs";

function setup(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-search-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, TYPESAFE_API_KEY: "fixture-only" };
  const sent = [];
  const fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    const request = sent.at(-1);
    return new Response(JSON.stringify({ model: PINNED_MODEL, answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 100, output_tokens: 0 } }), { headers: { "content-type": "application/json" } });
  };
  return { dir, env, sent, jev: openJev({ env, fetch, maxRetries: 0, ...options }) };
}

test("per-item cache reuses unchanged items and contains neither original nor query", async (t) => {
  const f = setup(t);
  const query = "public test query";
  const first = await searchByMeaning({ jev: f.jev, query, items: ["alpha", "beta"] });
  assert.equal(first.matches.length, 2);
  const second = await searchByMeaning({ jev: f.jev, query, items: ["beta", "alpha", "gamma"] });
  assert.equal(second.cachedCount, 2);
  assert.deepEqual(Object.values(f.sent[1].state.items), ["gamma"]);
  const third = await searchByMeaning({ jev: f.jev, query, items: ["gamma", "alpha"] });
  assert.equal(third.cached, true);
  assert.equal(third.spend, 0);
  const cacheDir = path.join(f.dir, "decision-gate/answers");
  for (const file of readdirSync(cacheDir).filter((f) => f.endsWith("jsonl"))) {
    const stored = readFileSync(path.join(cacheDir, file), "utf8");
    for (const text of ["alpha", "beta", "gamma", query, "fixture-only"]) assert.ok(!stored.includes(text));
  }
});

test("estimate needs no key; known formats are filtered while hashes and paths pass", (t) => {
  const f = setup(t, { key: { value: "" } });
  assert.equal(f.jev.status().ok, false);
  const hash = "abcdef1234567890".repeat(4);
  const estimate = estimateSearch({ jev: f.jev, query: "search", items: [hash, "./src/crypto/sha256Hmac/hmacSha256Digest.ts", "public@example.invalid", "Bearer abcdefghijklmnopqrst"] });
  assert.equal(estimate.changed, 2);
  assert.equal(f.sent.length, 0);
});

test("ceiling exhaustion returns the ranked prefix and does not send the tail", async (t) => {
  const f = setup(t, { spend: { perRunUsd: usdFor(MAX_INPUT_TOKENS), perDayUsd: 0.2 } });
  const result = await searchByMeaning({ jev: f.jev, query: "search", items: Array.from({ length: 17 }, (_, i) => `line ${i}`) });
  assert.equal(result.stopped, true);
  assert.equal(result.matches.length, 16);
  assert.equal(result.unjudged, 1);
  assert.equal(f.sent.length, 1);
});

test("cancelling a search aborts the request and closes its hold at the booked reservation", async (t) => {
  let started;
  const arrived = new Promise((resolve) => { started = resolve; });
  const f = setup(t, { fetch: (_url, init) => new Promise((_resolve, reject) => {
    started();
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  }) });
  const controller = new AbortController();
  const search = searchByMeaning({ jev: f.jev, query: "search", items: ["alpha"], signal: controller.signal });
  await arrived;
  controller.abort(new Error("cancelled"));
  await assert.rejects(search, /cancelled/);
  // The aborted attempt may have reached the service, so it stays booked; nothing else is held
  assert.equal(await f.jev.remaining(), 0.2 - usdFor(MAX_INPUT_TOKENS));
});

test("pickLine returns each item once at its best line and reports progress as batches finish", async (t) => {
  const f = setup(t, { fetch: async (_url, init) => {
    const request = JSON.parse(init.body);
    const answers = Object.fromEntries(Object.entries(request.state.items).map(([id, text]) => [id, { type: "noul", noul: text.includes("login") ? 0.9 : text.includes("auth") ? 0.7 : 0.1 }]));
    return new Response(JSON.stringify({ model: PINNED_MODEL, answers, usage: { input_tokens: 100 } }));
  } });
  const message = { id: "m1", text: "opening words\nauth header added\nfixed the login bug" };
  const found = [], progress = [];
  const result = await searchByMeaning({ jev: f.jev, query: "search", items: [message, { id: "m2", text: "garden\ntools" }], pickLine: true, onFound: (row) => found.push(row.line), onProgress: (step) => progress.push(step) });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].item, message);
  assert.equal(result.matches[0].line, "fixed the login bug");
  assert.equal(result.matches[0].lineIndex, 2);
  assert.deepEqual(found.sort(), ["auth header added", "fixed the login bug"]);
  assert.deepEqual(progress.map(({ judged, total }) => [judged, total]), [[5, 5]]);
});

test("batches run concurrently, and a full ceiling waits for in-flight attempts instead of stopping", async (t) => {
  let inFlight = 0, peak = 0;
  const fetch = async (_url, init) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 50));
    inFlight--;
    const request = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: PINNED_MODEL, answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 100 } }));
  };
  const items = Array.from({ length: 64 }, (_, i) => `line ${i}`);
  const open = setup(t, { fetch });
  const wide = await searchByMeaning({ jev: open.jev, query: "search", items });
  assert.equal(wide.matches.length, 64);
  assert.equal(peak, 4);
  peak = 0;
  // Room for two worst-case reservations: the other batches wait their turn rather than stop
  const tight = setup(t, { fetch, spend: { perRunUsd: 2 * usdFor(MAX_INPUT_TOKENS), perDayUsd: 0.2 } });
  const narrow = await searchByMeaning({ jev: tight.jev, query: "search", items });
  assert.equal(narrow.stopped, false);
  assert.equal(narrow.matches.length, 64);
  assert.equal(peak, 2);
  assert.equal(narrow.spend, 4 * usdFor(100));
  assert.equal(await tight.jev.remaining(), 0.2 - 4 * usdFor(100));
});

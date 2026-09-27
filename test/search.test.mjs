import test from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PINNED_MODEL, MAX_INPUT_TOKENS, MAX_STATE_QUESTION_TOKENS, usdFor } from "decision-gate";
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
  const f = setup(t, { key: { provider: "typesafe", value: "" } });
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
  // Eight batches, so the peak is the gate's in-flight setting rather than the batch count
  const items = Array.from({ length: 128 }, (_, i) => `line ${i}`);
  const open = setup(t, { fetch });
  const wide = await searchByMeaning({ jev: open.jev, query: "search", items });
  assert.equal(wide.matches.length, 128);
  assert.equal(peak, 4);
  peak = 0;
  // Room for two worst-case reservations: the other batches wait their turn rather than stop
  const tight = setup(t, { fetch, spend: { perRunUsd: 2 * usdFor(MAX_INPUT_TOKENS), perDayUsd: 0.2 } });
  const narrow = await searchByMeaning({ jev: tight.jev, query: "search", items });
  assert.equal(narrow.stopped, false);
  assert.equal(narrow.matches.length, 128);
  assert.equal(peak, 2);
  assert.equal(narrow.spend, 8 * usdFor(100));
  assert.equal(await tight.jev.remaining(), 0.2 - 8 * usdFor(100));
});

test("jevzf spends on its own key file ahead of TYPESAFE_API_KEY, then on decision-gate's defaults", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, { mode: 0o600 }); };
  write(path.join(dir, "jevzf/config.json"), JSON.stringify({ key_file: "jevzf-key" }));
  write(path.join(dir, "jevzf/jevzf-key"), "jevzf-fixture\n");
  write(path.join(dir, "decision-gate/config.json"), JSON.stringify({ key_file: "shared-key" }));
  write(path.join(dir, "decision-gate/shared-key"), "shared-fixture\n");
  write(path.join(dir, "other/config.json"), JSON.stringify({ key_file: "../other-key" }));
  write(path.join(dir, "other-key"), "override-fixture\n");
  const base = { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir };
  const sentWith = async (env) => {
    let authorization;
    const jev = openJev({ env, maxRetries: 0, fetch: async (_url, init) => {
      authorization = init.headers.Authorization ?? init.headers.authorization;
      const request = JSON.parse(init.body);
      return new Response(JSON.stringify({ model: PINNED_MODEL, answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 100 } }));
    } });
    await searchByMeaning({ jev, query: "search", items: ["alpha"], noCache: true });
    return authorization;
  };
  assert.equal(await sentWith(base), "Bearer jevzf-fixture");
  assert.equal(await sentWith({ ...base, JEVZF_CONFIG: path.join(dir, "other/config.json") }), "Bearer override-fixture");
  // Another tool's exported key must not take over jevzf's spend
  assert.equal(await sentWith({ ...base, TYPESAFE_API_KEY: "env-fixture" }), "Bearer jevzf-fixture");
  rmSync(path.join(dir, "jevzf/config.json"));
  assert.equal(await sentWith({ ...base, TYPESAFE_API_KEY: "env-fixture" }), "Bearer env-fixture");
  assert.equal(await sentWith(base), "Bearer shared-fixture");
  assert.throws(() => openJev({ env: { ...base, JEVZF_CONFIG: path.join(dir, "missing.json") } }), /cannot read jevzf config/);
  write(path.join(dir, "jevzf/config.json"), JSON.stringify({ key_file: "jevzf-key", spend: { per_day_usd: 1 } }));
  assert.throws(() => openJev({ env: base }), /holds only key_file/);
});

test("jevzf's key file is TypeSafe's, so the gateway provider never receives it", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-gateway-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, { mode: 0o600 }); };
  write(path.join(dir, "jevzf/config.json"), JSON.stringify({ key_file: "jevzf-key" }));
  write(path.join(dir, "jevzf/jevzf-key"), "jevzf-fixture\n");
  const env = { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, DECISION_GATE_PROVIDER: "vercel-ai-gateway", TYPESAFE_API_KEY: "typesafe-fixture" };
  const missing = openJev({ env }).status();
  assert.deepEqual([missing.missing, missing.label, missing.keyEnv], [true, "Vercel AI Gateway", "AI_GATEWAY_API_KEY"]);
  const sent = [];
  const jev = openJev({ env: { ...env, AI_GATEWAY_API_KEY: "gateway-fixture" }, maxRetries: 0, fetch: async (url, init) => {
    sent.push([url, init.headers.Authorization ?? init.headers.authorization]);
    const request = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: "typesafe-ai/jev", answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 100 } }));
  } });
  await searchByMeaning({ jev, query: "search", items: ["alpha"], noCache: true });
  assert.deepEqual(sent, [["https://ai-gateway.vercel.sh/typesafe/v1/systemone", "Bearer gateway-fixture"]]);
});

test("searches queued behind the account's in-flight slot wait without spending their attempt timeout", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-search-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Each answer takes longer than half the attempt timeout, so a request queued behind two others
  // would time out if its wait for the slot counted against its attempt; the 400 ms left over keeps
  // a loaded machine running the whole suite from timing out an answer that was never queued
  let open = 0, peak = 0, served = 0;
  const server = createServer(async (req, res) => {
    open++; peak = Math.max(peak, open);
    let body = "";
    for await (const chunk of req) body += chunk;
    await new Promise((resolve) => setTimeout(resolve, 600));
    open--; served++;
    const { questions } = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: PINNED_MODEL, answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 100 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = path.join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ limits: { in_flight: 1 } }));
  const env = { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, TYPESAFE_API_KEY: "fixture-only", DECISION_GATE_CONFIG: config, DECISION_GATE_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/systemone` };
  // Two searches at once put two workers on the account's one slot, each with two batches
  const search = (name) => searchByMeaning({ jev: openJev({ env, maxRetries: 0, timeoutMs: 1000 }), query: "search", items: Array.from({ length: 17 }, (_, i) => `${name} line ${i}`), noCache: true });
  const results = await Promise.all([search("first"), search("second")]);
  assert.equal(peak, 1);
  assert.equal(served, 4);
  for (const result of results) {
    assert.equal(result.failed, 0);
    assert.equal(result.matches.length, 17);
    assert.equal(result.tokens, 200);
    assert.equal(result.spend, usdFor(200));
  }
});

test("a 429 on one of four workers under a tight ceiling does not stop the search", async (t) => {
  let calls = 0;
  // Three reservations fit, so the fourth worker is waiting for room when the first answer is a 429
  const f = setup(t, { maxRetries: 1, spend: { perRunUsd: 3 * usdFor(MAX_INPUT_TOKENS) + usdFor(10000), perDayUsd: 0.2 }, fetch: async (_url, init) => {
    if (++calls === 1) return new Response("{}", { status: 429, headers: { "retry-after-ms": "1" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { questions } = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: PINNED_MODEL, answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 100 } }), { headers: { "content-type": "application/json" } });
  } });
  const result = await searchByMeaning({ jev: f.jev, query: "search", items: Array.from({ length: 64 }, (_, i) => `line ${i}`) });
  assert.equal(result.stopped, false);
  assert.equal(result.failed, 0);
  assert.equal(result.matches.length, 64);
  assert.equal(calls, 5);
  assert.equal(result.tokens, 400);
});

test("lines that grow when JSON-encoded are packed so each request's state stays under the model's state budget", async (t) => {
  const f = setup(t, { spend: { perRunUsd: 1, perDayUsd: 1 } });
  // Each control character encodes as six bytes, so 16 of these fill a 24000-byte batch sixfold
  const items = Array.from({ length: 16 }, (_, i) => `${"\x01".repeat(1400)}${i}`);
  const result = await searchByMeaning({ jev: f.jev, query: "control characters", items });
  assert.equal(result.matches.length, 16);
  assert.ok(f.sent.length > 1);
  for (const request of f.sent) {
    const longest = Math.max(...Object.values(request.questions).map((q) => Buffer.byteLength(JSON.stringify(q))));
    assert.ok((Buffer.byteLength(JSON.stringify(request.state)) + longest) / 4 <= MAX_STATE_QUESTION_TOKENS);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, chmodSync, mkdirSync, existsSync, statSync, utimesSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { openJev, searchByMeaning, estimateSearch } from "../lib/core.mjs";
import { createLimiter } from "../lib/limits.mjs";
import { createLedger } from "../lib/spend.mjs";
import { answerCache } from "../lib/cache.mjs";
import { locked } from "../lib/state.mjs";
import { PINNED_MODEL, MAX_INPUT_TOKENS, usdFor } from "../lib/meaning/jev.mjs";

function setup(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-core-"));
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
const request = (text) => ({ model: PINNED_MODEL, state: { text }, questions: { q: { type: "noul", instructions: "Is the text useful?" } } });

for (const status of [429, 529]) {
  test(`SDK retries HTTP ${status} through the shared limiter and accounting`, async (t) => {
    let attempts = 0;
    const f = setup(t, { maxRetries: 1, fetch: async () => {
      attempts++;
      if (attempts === 1) return new Response("private provider error", { status, headers: { "retry-after-ms": "1" } });
      return new Response(JSON.stringify({ model: PINNED_MODEL, answers: { q: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 100 } }));
    } });
    const run = f.jev.run();
    assert.equal((await run.ask(request("public"))).answers.q.noul, 0.8);
    await run.close();
    assert.equal(attempts, 2);
    assert.equal(run.summary().committed_usd, usdFor(100) + (status === 529 ? usdFor(MAX_INPUT_TOKENS) : 0));
    const dir = path.join(f.dir, "jevzf/limits");
    const state = JSON.parse(readFileSync(path.join(dir, readdirSync(dir).find((name) => name.endsWith(".json")))));
    assert.equal(state.starts.length, 2);
    assert.ok(state.pausedUntil > 0);
  });
}

test("raw core asks use the SDK and never-send gate without caller redaction", async (t) => {
  const f = setup(t);
  const run = f.jev.run();
  await assert.rejects(run.ask(request("Bearer abcdefghijklmnopqrst")), /never-send/);
  assert.equal(f.sent.length, 0);
  const result = await run.ask(request("public fixture"));
  assert.equal(result.answers.q.noul, 0.9);
  await run.close();
  assert.equal(f.sent.length, 1);
  assert.equal(run.summary().committed_usd, usdFor(100));
  await assert.rejects(run.ask(request("after close")), /closed/);
});

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
  const cacheDir = path.join(f.dir, "jevzf/answers");
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

test("shared limiter enforces rolling requests, reserved tokens and pauses using a fake clock", async (t) => {
  const f = setup(t);
  let now = 100000;
  const waits = [];
  const time = { now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } };
  const options = { stateDir: f.dir, fingerprint: "shared", limits: { requestsPerMinute: 2, tokensPerSecond: 100, share: 1 }, time };
  const a = createLimiter(options), b = createLimiter(options);
  await a.take(60);
  await b.take(60);
  assert.equal(now, 101000);
  await a.take(60);
  assert.equal(now, 160000);
  await a.pause(7000);
  await b.take(20);
  assert.equal(now, 167000);
  assert.deepEqual(waits, [1000, 59000, 7000]);
});

test("ledger holds reserve capacity across callers, and a stale hold retains booked cost", async (t) => {
  const f = setup(t);
  let now = Date.UTC(2026, 8, 26);
  const time = { now: () => now, sleep: async (ms) => { now += ms; } };
  const options = { stateDir: f.dir, fingerprint: "shared", tool: "fixture", perDayUsd: 0.02, time };
  const a = createLedger(options), b = createLedger(options);
  const first = await a.open(0.02);
  await first.book(0.001);
  assert.equal((await b.open(0.02)).capUsd, 0);
  now += 600001;
  assert.equal(await b.remaining(), 0.019);
  const second = await b.open(0.019);
  await assert.rejects(first.book(0.002), /daily spend ceiling/);
  await first.close(0.001);
  await second.close(0.002);
  assert.equal(await a.remaining(), 0.017);
});

test("a run can close its old-day ledger after midnight without spending on the new day", async (t) => {
  const f = setup(t);
  let now = Date.UTC(2026, 8, 26, 23, 59, 59);
  const time = { now: () => now, sleep: async (ms) => { now += ms; } };
  const ledger = createLedger({ stateDir: f.dir, fingerprint: "midnight", tool: "fixture", perDayUsd: 0.02, time });
  const run = await ledger.open(0.02);
  await run.book(0.001);
  now += 2000;
  await assert.rejects(run.book(0.002), /UTC day changed/);
  await run.close(0.001);
  assert.equal(await ledger.remaining(), 0.02);
});

test("ceiling exhaustion returns the ranked prefix and does not send the tail", async (t) => {
  const f = setup(t, { spend: { perSearchUsd: usdFor(MAX_INPUT_TOKENS), perDayUsd: 0.2 } });
  const result = await searchByMeaning({ jev: f.jev, query: "search", items: Array.from({ length: 17 }, (_, i) => `line ${i}`) });
  assert.equal(result.stopped, true);
  assert.equal(result.matches.length, 16);
  assert.equal(result.unjudged, 1);
  assert.equal(f.sent.length, 1);
});

test("explicit key file takes precedence over the environment and enforces mode 600", async (t) => {
  const f = setup(t);
  const file = path.join(f.dir, "key");
  writeFileSync(file, "private-file-key", { mode: 0o600 });
  let authorization;
  const jev = openJev({ env: f.env, key: { file }, maxRetries: 0, fetch: async (_url, init) => {
    authorization = init.headers.Authorization ?? init.headers.authorization;
    return new Response(JSON.stringify({ model: PINNED_MODEL, answers: { q: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 100 } }));
  } });
  const run = jev.run();
  await run.ask(request("public"));
  await run.close();
  assert.equal(authorization, "Bearer private-file-key");
  chmodSync(file, 0o644);
  const unsafe = openJev({ env: f.env, key: { file } });
  assert.equal(unsafe.status().ok, false);
  const refused = unsafe.run();
  await assert.rejects(refused.ask(request("public")), /chmod 600/);
  await refused.close();
});

test("separate processes share one limiter window for the same key", async (t) => {
  const f = setup(t);
  const script = `
    import { createLimiter } from ${JSON.stringify(new URL("../lib/limits.mjs", import.meta.url).href)};
    const limiter = createLimiter({ stateDir: process.argv[1], fingerprint: "shared", limits: { requestsPerMinute: 100, tokensPerSecond: 100, share: 1 } });
    await limiter.take(60);
  `;
  const child = () => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", script, f.dir]);
    proc.on("error", reject);
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`limiter child exited ${code}`)));
  });
  await Promise.all([child(), child(), child()]);
  // Each take reserves 60 of 100 tokens a second, so the shared window must space the three starts
  const { starts } = JSON.parse(readFileSync(path.join(f.dir, "limits", "shared.json"), "utf8"));
  const times = starts.map((start) => start.at).sort((a, b) => a - b);
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 1000, `${times}`);
  assert.ok(times[2] - times[1] >= 1000, `${times}`);
});

test("locks left by dead or stopped owners are reclaimed, and live fresh locks are respected", async (t) => {
  const f = setup(t);
  const file = path.join(f.dir, "state.json");
  const lock = `${file}.lock`;
  const plant = (pid, ageMs = 0, host = hostname()) => {
    mkdirSync(lock);
    writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ host, pid, token: crypto.randomUUID() }));
    if (ageMs) utimesSync(lock, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  };
  const gone = spawnSync(process.execPath, ["-e", "0"]).pid;
  plant(gone);
  // A crashed acquirer's unpublished directory must not block anyone
  mkdirSync(`${lock}.${crypto.randomUUID()}.tmp`);
  assert.equal(await locked(file, () => "dead owner"), "dead owner");
  assert.ok(!existsSync(lock));
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  t.after(() => sleeper.kill());
  // A live owner holding a lock this long is stopped, since holders never wait on anything
  plant(sleeper.pid, 31000);
  assert.equal(await locked(file, () => "stopped owner"), "stopped owner");
  plant(sleeper.pid);
  let now = 0;
  const time = { now: () => now, sleep: async (ms) => { now += ms; } };
  await assert.rejects(locked(file, () => "stolen", { time, timeoutMs: 100 }), /lock timed out/);
  assert.ok(existsSync(lock));
  rmSync(lock, { recursive: true });
  // A lock naming this process's own pid that this process does not hold came from a reused pid
  plant(process.pid);
  assert.equal(await locked(file, () => "reused pid"), "reused pid");
  // Another host's pid proves nothing here, so only age can free its lock
  plant(gone, 0, `not-${hostname()}`);
  await assert.rejects(locked(file, () => "stolen", { time, timeoutMs: 100 }), /lock timed out/);
  assert.ok(existsSync(lock));
});

test("a second reaper cannot move a newer lock onto the same stale owner's tombstone", async (t) => {
  const f = setup(t);
  const file = path.join(f.dir, "state.json");
  const lock = `${file}.lock`;
  const stale = crypto.randomUUID();
  const gone = spawnSync(process.execPath, ["-e", "0"]).pid;
  const plant = (marker) => {
    mkdirSync(lock);
    writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ host: hostname(), pid: gone, token: stale }));
    if (marker) mkdirSync(path.join(lock, marker));
  };
  plant();
  await locked(file, () => {});
  assert.ok(existsSync(`${lock}.${stale}.stale`));
  // A reaper that read the old owner before the first reaper moved it now sees a newer lock
  // under that owner's name; the kept tombstone makes its move fail instead of stealing it
  plant("newer");
  let now = 0;
  const time = { now: () => now, sleep: async (ms) => { now += ms; } };
  await assert.rejects(locked(file, () => "stolen", { time, timeoutMs: 60 }), /lock timed out/);
  assert.ok(existsSync(path.join(lock, "newer")));
});

test("spend ledger compaction drops past days and superseded rows but keeps today's holds", async (t) => {
  const f = setup(t);
  const now = Date.UTC(2026, 8, 26, 12);
  const time = { now: () => now, sleep: async () => {} };
  const file = path.join(f.dir, "spend", "compact.jsonl");
  mkdirSync(path.dirname(file), { recursive: true });
  const old = Array.from({ length: 400 }, (_, i) => JSON.stringify({ id: `old${i}`, tool: "fixture", day: "2026-09-20", at: now - 6 * 86400000, usd: 0.01, hold: 0.01, closed: true }));
  const today = JSON.stringify({ id: "today", tool: "fixture", day: "2026-09-26", at: now - 1000, usd: 0.005, hold: 0.005, closed: true });
  writeFileSync(file, `${[...old, today].join("\n")}\n`, { mode: 0o600 });
  const ledger = createLedger({ stateDir: f.dir, fingerprint: "compact", tool: "fixture", perDayUsd: 0.02, time });
  assert.equal(await ledger.remaining(), 0.015);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.deepEqual(lines, [today]);
});

test("answer cache rewrites a file whose rows are mostly expired", async (t) => {
  const f = setup(t);
  let now = Date.UTC(2026, 8, 26);
  const time = { now: () => now, sleep: async () => {} };
  const options = { stateDir: f.dir, cacheDir: path.join(f.dir, "answers"), scope: { query: "fixture" }, time };
  await answerCache(options).put(Array.from({ length: 300 }, (_, i) => [`line ${i}`, 0.5]));
  now += 31 * 86400000;
  const cache = answerCache(options);
  assert.equal(cache.get("line 1"), undefined);
  await cache.put([["fresh", 0.7]]);
  const [name] = readdirSync(options.cacheDir).filter((file) => file.endsWith(".jsonl"));
  assert.equal(readFileSync(path.join(options.cacheDir, name), "utf8").trim().split("\n").length, 1);
  assert.equal(answerCache(options).get("fresh"), 0.7);
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
  const tight = setup(t, { fetch, spend: { perSearchUsd: 2 * usdFor(MAX_INPUT_TOKENS), perDayUsd: 0.2 } });
  const narrow = await searchByMeaning({ jev: tight.jev, query: "search", items });
  assert.equal(narrow.stopped, false);
  assert.equal(narrow.matches.length, 64);
  assert.equal(peak, 2);
  assert.equal(narrow.spend, 4 * usdFor(100));
  assert.equal(await tight.jev.remaining(), 0.2 - 4 * usdFor(100));
});

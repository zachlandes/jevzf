import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_INPUT_TOKENS, usdFor, PINNED_MODEL } from "../lib/meaning/jev.mjs";

const cli = process.env.JEVZF_TEST_CLI ? path.resolve(process.env.JEVZF_TEST_CLI) : fileURLToPath(new URL("../bin/jevzf.mjs", import.meta.url));
const fzfVersion = spawnSync("fzf", ["--version"], { encoding: "utf8" }).stdout?.match(/^(\d+)\.(\d+)/);
const supportedFzf = fzfVersion && (Number(fzfVersion[1]) > 0 || Number(fzfVersion[2]) >= 65);
const reservation = usdFor(MAX_INPUT_TOKENS);
const fingerprint = createHash("sha256").update("test-credential").digest("hex").slice(0, 16);

async function fixture(t, respond) {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-test-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({ body, parsed, authorization: req.headers.authorization });
    if (respond && await respond(req, res, parsed, requests.length)) return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      model: PINNED_MODEL,
      answers: Object.fromEntries(Object.entries(parsed.state.items).map(([id, line]) => [id, { type: "noul", noul: line.includes("login") ? 0.97 : line.includes("reset") ? 0.8 : 0.1 }])),
      usage: { input_tokens: 100, output_tokens: 20 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const key = path.join(dir, "key"), redaction = path.join(dir, "redaction.json"), config = path.join(dir, "config.json");
  writeFileSync(key, "test-credential", { mode: 0o600 });
  writeFileSync(redaction, JSON.stringify({ rules: [["private", "(?i)Private Person", "[person]"]], forbidden: ["(?i)Private Person"] }), { mode: 0o600 });
  writeFileSync(config, "{}");
  const env = {
    PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir,
    JEVZF_CONFIG: config, JEVZF_STATE_DIR: path.join(dir, "state"),
    JEVZF_KEY_FILE: key, JEVZF_NEVER_SEND_FILE: redaction,
    JEVZF_JEV_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/systemone`
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (input, query = "authentication", overrides = {}, args = [query]) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...overrides } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
  const ledgerFile = path.join(dir, "state/spend", `${fingerprint}.jsonl`);
  const ledger = () => readFileSync(ledgerFile, "utf8").trim().split("\n").map(JSON.parse);
  return { dir, requests, run, env, config, key, redaction, ledger, ledgerFile };
}

test("every network attempt has its durable reservation before the loopback server receives it", async (t) => {
  const f = await fixture(t, () => { assert.equal(f.ledger().at(-1).usd, reservation); });
  assert.equal((await f.run("login\nreset\ngarden\n")).stdout, "login\nreset\n");
  assert.equal(f.ledger().at(-1).usd, usdFor(100));
  assert.equal(f.ledger().at(-1).closed, true);
});

test("redacts every batch and retry, both query and lines, but prints original matches", async (t) => {
  const f = await fixture(t, (_req, res, _body, n) => {
    if (n === 1) { res.writeHead(503); res.end(); return true; }
  });
  const lines = Array.from({ length: 33 }, (_, i) => `login Private Person ${i} Bearer abcdefghijklmnopqrst`);
  const result = await f.run(`${lines.join("\n")}\n`, "Private Person login");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.requests.length, 4);
  assert.ok(result.stdout.includes("Private Person"));
  for (const request of f.requests) {
    assert.ok(!request.body.toLowerCase().includes("private person"));
    assert.ok(!request.body.includes("abcdefghijklmnopqrst"));
    assert.ok(request.body.includes("[person]"));
    assert.equal(request.authorization, "Bearer test-credential");
  }
});

test("a forbidden survivor in a later batch blocks every request", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.redaction, JSON.stringify({ rules: [], forbidden: ["zz-secret"] }));
  const result = await f.run([...Array.from({ length: 20 }, (_, i) => `login ${i}`), "zz-secret"].join("\n"));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /never-send check refused/);
  assert.equal(f.requests.length, 0);
});

test("decoded forbidden text is caught even when JSON would escape it", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.redaction, JSON.stringify({ rules: [], forbidden: ["a\tb"] }));
  assert.equal((await f.run("login a\tb")).code, 2);
  assert.equal(f.requests.length, 0);
});

test("daily cap persists across processes while cached results remain free", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.config, JSON.stringify({ spend: { per_day_usd: reservation + usdFor(100) / 2 } }));
  assert.equal((await f.run("login\n")).code, 0);
  const capped = await f.run("login\n", "different query");
  assert.equal(capped.code, 1);
  assert.match(capped.stderr, /ceiling reached; 1 lines unjudged/);
  assert.equal((await f.run("login\n")).code, 0);
  assert.equal(f.requests.length, 1);
});

test("simultaneous CLI processes cannot allocate the same daily allowance", async (t) => {
  const f = await fixture(t, async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  writeFileSync(f.config, JSON.stringify({ spend: { per_day_usd: reservation, per_search_usd: reservation } }));
  const results = await Promise.all([f.run("login\n", "query one"), f.run("login\n", "query two")]);
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 1]);
  assert.equal(f.requests.length, 1);
});

test("uncertain failures consume their reservation and retries cannot exceed the cap", async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(503); res.end("private provider error"); return true; });
  writeFileSync(f.config, JSON.stringify({ spend: { per_search_usd: reservation, per_day_usd: reservation } }));
  const result = await f.run("login\n");
  assert.equal(result.code, 2);
  assert.equal(f.requests.length, 1);
  assert.ok(!result.stderr.includes("private provider error"));
  assert.equal(f.ledger().at(-1).usd, reservation);
  assert.equal((await f.run("login\n")).code, 1);
  assert.equal(f.requests.length, 1);
});

test("a process killed after sending leaves its reservation and does not retain a network-duration lock", async (t) => {
  let arrived;
  const received = new Promise((resolve) => { arrived = resolve; });
  const f = await fixture(t, () => { arrived(); return true; });
  writeFileSync(f.config, JSON.stringify({ spend: { per_day_usd: reservation } }));
  const child = spawn(process.execPath, [cli, "query"], { env: f.env, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end("login\n");
  await received;
  const closed = new Promise((resolve) => child.on("close", resolve));
  child.kill("SIGKILL");
  await closed;
  assert.equal(f.ledger().at(-1).usd, reservation);
  assert.equal((await f.run("login\n")).code, 1);
  assert.equal(f.requests.length, 1);
});

test("corrupt accounting fails closed instead of resetting daily spend", async (t) => {
  const f = await fixture(t);
  mkdirSync(path.dirname(f.ledgerFile), { recursive: true });
  writeFileSync(f.ledgerFile, "not json\n");
  assert.equal((await f.run("login\n")).code, 2);
  assert.equal(f.requests.length, 0);
});

test("SDK environment settings cannot redirect credentials or turn on request logging", async (t) => {
  const f = await fixture(t);
  const result = await f.run("login Private Person\n", "authentication", { TYPESAFE_BASE_URL: "https://example.com", TYPESAFE_LOG_LEVEL: "debug", TYPESAFE_DEFAULT_MODEL: "other" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].authorization, "Bearer test-credential");
  assert.equal(f.requests[0].parsed.model, PINNED_MODEL);
  assert.ok(!result.stderr.includes("Private Person") && !result.stderr.includes("test-credential") && !result.stderr.includes("typesafe-sdk"));
});

test("zero caps permit cached results but no paid request; malformed env amounts fail", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run("login\n")).code, 0);
  assert.equal((await f.run("login\n", "authentication", { JEVZF_PER_SEARCH_USD: "0" })).code, 0);
  assert.equal((await f.run("login\n", "different", { JEVZF_PER_SEARCH_USD: "0" })).code, 1);
  assert.equal((await f.run("login\n", "query", { JEVZF_PER_DAY_USD: "not-a-number" })).code, 2);
  assert.equal(f.requests.length, 1);
});

test("malformed responses fail and are never cached", async (t) => {
  const f = await fixture(t, (_req, res) => { res.end(JSON.stringify({ model: PINNED_MODEL, answers: {}, usage: { input_tokens: 100 } })); return true; });
  assert.equal((await f.run("login\n")).code, 2);
  assert.equal((await f.run("login\n")).code, 2);
  assert.equal(f.requests.length, 2);
});

test("remote endpoint overrides and redirects cannot receive the credential", async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(307, { location: "/stolen" }); res.end(); return true; });
  assert.equal((await f.run("login\n", "query", { JEVZF_JEV_ENDPOINT: "https://example.com/" })).code, 2);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.run("login\n")).code, 2);
  assert.equal(f.requests.length, 1);
});

test("invalid config, missing privacy rules, empty key and oversized input send nothing", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run("login\n", "query", { JEVZF_NEVER_SEND_FILE: path.join(f.dir, "missing") })).code, 2);
  assert.equal((await f.run("login\n", "x".repeat(401))).code, 2);
  assert.equal((await f.run("a".repeat(24001))).code, 2);
  writeFileSync(f.config, JSON.stringify({ spend: { per_day_usd: -1 } }));
  assert.equal((await f.run("login\n")).code, 2);
  writeFileSync(f.config, "{}");
  writeFileSync(f.key, "");
  assert.equal((await f.run("login\n")).code, 2);
  assert.equal(f.requests.length, 0);
});

test("the README fzf recipe reloads original candidates by meaning and preserves its order", { skip: !supportedFzf || spawnSync("python3", ["--version"]).status !== 0 }, async (t) => {
  const f = await fixture(t);
  const bindir = path.join(f.dir, "bin");
  mkdirSync(bindir);
  symlinkSync(cli, path.join(bindir, "jevzf"));
  const input = path.join(f.dir, "input"), output = path.join(f.dir, "result");
  writeFileSync(input, "garden tools\nlogin service\n");
  const query = "signing in ' ; echo nope";
  const result = await new Promise((resolve) => {
    const child = spawn("python3", [fileURLToPath(new URL("./fzf-driver.py", import.meta.url))], {
      env: { ...f.env, PATH: `${bindir}:${process.env.PATH}`, TERM: "xterm-256color", JEVZF_INPUT: input, RESULT: output, READY: path.join(f.dir, "ready"), SEARCH_QUERY: query }
    });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "login service\n");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].parsed.state.search, query);
});

test("help and version ignore invalid config; no matches return 1", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.config, "not json");
  assert.match((await f.run("", "", {}, ["--help"])).stdout, /Usage:/);
  assert.equal((await f.run("", "", {}, ["--version"])).stdout, "0.1.0\n");
  writeFileSync(f.config, "{}");
  assert.equal((await f.run("gardening\n")).code, 1);
});

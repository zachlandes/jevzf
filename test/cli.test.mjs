import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_INPUT_TOKENS, usdFor, PINNED_MODEL } from "../lib/meaning/jev.mjs";
import { createSearch } from "../lib/core.mjs";
import { createRedactor } from "../lib/meaning/redaction.mjs";
import { withState } from "../lib/state.mjs";

const cli = process.env.JEVZF_TEST_CLI ? path.resolve(process.env.JEVZF_TEST_CLI) : fileURLToPath(new URL("../bin/jevzf.mjs", import.meta.url));
const fzfVersion = spawnSync("fzf", ["--version"], { encoding: "utf8" }).stdout?.match(/^(\d+)\.(\d+)/);
const supportedFzf = fzfVersion && (Number(fzfVersion[1]) > 0 || Number(fzfVersion[2]) >= 65);
const reservation = usdFor(MAX_INPUT_TOKENS);

function answer(res, parsed, tokens = 100) {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    model: PINNED_MODEL,
    answers: Object.fromEntries(Object.entries(parsed.state.items).map(([id, line]) => [id, { type: "noul", noul: line.includes("login") ? 0.97 : line.includes("reset") ? 0.8 : 0.1 }])),
    usage: { input_tokens: tokens, output_tokens: 20 }
  }));
  return true;
}

async function fixture(t, respond) {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-test-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({ body, parsed, authorization: req.headers.authorization });
    if (respond && await respond(req, res, parsed, requests.length)) return;
    answer(res, parsed);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const key = path.join(dir, "key");
  const redaction = path.join(dir, "redaction.json");
  const config = path.join(dir, "config.json");
  writeFileSync(key, "test-credential", { mode: 0o600 });
  writeFileSync(redaction, JSON.stringify({ rules: [["private", "(?i)Private Person", "[person]"]], forbidden: ["(?i)Private Person"] }), { mode: 0o600 });
  writeFileSync(config, "{}");
  const env = {
    PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir,
    JEVZF_CONFIG: config, JEVZF_STATE_DIR: path.join(dir, "state"),
    JEVZF_KEY_FILE: key, JEVZF_REDACTION_FILE: redaction,
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
  return { dir, requests, run, env, config, key, redaction };
}

test("CLI ranks original lines; caps appear before sending; cache is keyed by the set, query and redaction", async (t) => {
  const f = await fixture(t, (_req, _res, _body) => {
    const ledger = JSON.parse(readFileSync(path.join(f.dir, "state/spend.json")));
    assert.equal(ledger.at(-1).usd, reservation);
  });
  const first = await f.run("reset password\nlogin service\ngardening\n");
  assert.equal(first.code, 0);
  assert.equal(first.stdout, "login service\nreset password\n");
  assert.match(first.stderr, /about \$.*search cap \$0.02; rolling 24h cap \$0.2/);
  assert.equal(f.requests.length, 1);
  const repeated = await f.run("gardening\nlogin service\nreset password\nlogin service\n");
  assert.equal(repeated.stdout, first.stdout);
  assert.match(repeated.stderr, /cache hit; cost \$0/);
  assert.equal(f.requests.length, 1);
  await f.run("login service\nnew line\n");
  await f.run("login service\nnew line\n", "another query");
  writeFileSync(f.redaction, JSON.stringify({ rules: [], forbidden: [] }));
  await f.run("login service\nnew line\n", "another query");
  assert.equal(f.requests.length, 4);
  for (const file of readdirSync(path.join(f.dir, "state"))) {
    const text = readFileSync(path.join(f.dir, "state", file), "utf8");
    assert.ok(!text.includes("login service") && !text.includes("authentication") && !text.includes("test-credential"));
  }
});

test("no key passes bytes unchanged without network, even with TYPESAFE_API_KEY set", async (t) => {
  const f = await fixture(t);
  const input = "login service\r\nPrivate Person\n\nlast line";
  const result = await f.run(input, "query", { JEVZF_KEY_FILE: "", TYPESAFE_API_KEY: "do-not-use" });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, input);
  assert.match(result.stderr, /meaning search is off.*passing input through/);
  assert.equal(result.stderr.trim().split("\n").length, 1);
  assert.equal(f.requests.length, 0);
});

test("redacts every batch and retry, both query and lines, but prints original matches", async (t) => {
  const f = await fixture(t, (_req, res, _body, n) => {
    if (n === 1) { res.writeHead(503); res.end(); return true; }
  });
  const lines = Array.from({ length: 33 }, (_, i) => `login Private Person ${i} private@example.com`);
  const result = await f.run(lines.join("\n"), "Private Person login");
  assert.equal(result.code, 0);
  assert.equal(f.requests.length, 4);
  assert.ok(result.stdout.includes("Private Person"));
  for (const request of f.requests) {
    assert.ok(!request.body.toLowerCase().includes("private person"));
    assert.ok(!request.body.includes("private@example.com"));
    assert.ok(request.body.includes("[person]"));
    assert.equal(request.authorization, "Bearer test-credential");
  }
});

test("a forbidden survivor in a later batch blocks every request", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.redaction, JSON.stringify({ rules: [], forbidden: ["zz-secret"] }));
  const result = await f.run([...Array.from({ length: 20 }, (_, i) => `login ${i}`), "zz-secret"].join("\n"));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /redaction check refused/);
  assert.equal(f.requests.length, 0);
});

test("decoded forbidden text is caught even when JSON would escape it", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.redaction, JSON.stringify({ rules: [], forbidden: ["a\tb"] }));
  const result = await f.run("login a\tb");
  assert.equal(result.code, 2);
  assert.equal(f.requests.length, 0);
});

test("per-search cap rejects unaffordable reservations before sending", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.config, JSON.stringify({ search_cap_usd: reservation - 0.000000001 }));
  const result = await f.run("login");
  assert.equal(result.code, 2);
  assert.match(result.stderr, /search cap.*rolling 24h cap/);
  assert.match(result.stderr, /exceeds the available.*raise search_cap_usd/);
  assert.equal(f.requests.length, 0);
});

test("a search the caps cannot finish is refused before any request", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.config, JSON.stringify({ search_cap_usd: reservation + usdFor(500) }));
  const result = await f.run(Array.from({ length: 100 }, (_, i) => `login ${i}`).join("\n"));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /estimated cost plus one request reservation.*raise search_cap_usd.*nothing sent/);
  assert.equal(f.requests.length, 0);
  assert.ok(!readdirSync(path.join(f.dir, "state")).includes("spend.json"));
});

test("daily cap persists across CLI processes; cached results remain free", async (t) => {
  const f = await fixture(t, (_req, res, parsed) => answer(res, parsed, 5000));
  writeFileSync(f.config, JSON.stringify({ daily_cap_usd: reservation + usdFor(2000) }));
  assert.equal((await f.run("login")).code, 0);
  assert.equal((await f.run("login", "different query")).code, 2);
  assert.equal((await f.run("login")).code, 0);
  assert.equal(f.requests.length, 1);
});

test("concurrent identical searches serialize and the second uses cache", async (t) => {
  const f = await fixture(t, async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  const results = await Promise.all([f.run("login"), f.run("login")]);
  assert.ok(results.every((r) => r.code === 0 && r.stdout === "login\n"));
  assert.equal(f.requests.length, 1);
  assert.ok(results.some((r) => r.stderr.includes("cache hit")));
});

test("uncertain failures consume their reservation and retries cannot exceed the cap", async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(503); res.end("private provider error"); return true; });
  writeFileSync(f.config, JSON.stringify({ search_cap_usd: reservation + usdFor(1000), daily_cap_usd: reservation + usdFor(1000) }));
  const result = await f.run("login");
  assert.equal(result.code, 2);
  assert.equal(f.requests.length, 1);
  assert.ok(!result.stderr.includes("private provider error"));
  assert.equal(JSON.parse(readFileSync(path.join(f.dir, "state/spend.json")))[0].usd, reservation);
  assert.equal((await f.run("login")).code, 2);
  assert.equal(f.requests.length, 1);
});

test("a killed search keeps its reservation and its lock does not block the next search", async (t) => {
  let arrived;
  const received = new Promise((resolve) => { arrived = resolve; });
  const f = await fixture(t, () => { arrived(); return true; });
  writeFileSync(f.config, JSON.stringify({ daily_cap_usd: reservation + usdFor(1000) }));
  const child = spawn(process.execPath, [cli, "query"], { env: f.env, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end("login\n");
  await received;
  const closed = new Promise((resolve) => child.on("close", resolve));
  child.kill("SIGKILL");
  await closed;
  assert.equal(JSON.parse(readFileSync(path.join(f.dir, "state/spend.json")))[0].usd, reservation);
  const began = Date.now();
  const restarted = await f.run("login");
  assert.ok(Date.now() - began < 10000);
  assert.equal(restarted.code, 2);
  assert.match(restarted.stderr, /raise daily_cap_usd/);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(readdirSync(path.join(f.dir, "state")).sort(), ["spend.json"]);
});

test("a lock whose owner is still running is never taken over", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  t.after(() => sleeper.kill("SIGKILL"));
  mkdirSync(path.join(dir, "search.lock"), { recursive: true });
  writeFileSync(path.join(dir, "search.lock/owner"), JSON.stringify({ host: hostname(), pid: sleeper.pid, token: "held" }));
  await assert.rejects(withState(dir, async () => "ran", { lockTimeoutMs: 300 }), /locked by another running search/);
  const exited = new Promise((resolve) => sleeper.on("exit", resolve));
  sleeper.kill("SIGKILL");
  await exited;
  assert.equal(await withState(dir, async () => "ran", { lockTimeoutMs: 300 }), "ran");
});

test("a lock owned on another host is never broken, and the timeout says how to recover", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "search.lock");
  mkdirSync(lock);
  const owner = JSON.stringify({ host: `not-${hostname()}`, pid: 2 ** 22 + 1, token: "remote" });
  writeFileSync(path.join(lock, "owner"), owner);
  await assert.rejects(withState(dir, async () => "ran", { lockTimeoutMs: 300 }), (error) => error.message.includes(`remove ${lock}`));
  assert.equal(readFileSync(path.join(lock, "owner"), "utf8"), owner);
});

test("releasing leaves alone a lock that is no longer ours", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const successor = JSON.stringify({ host: `not-${hostname()}`, pid: 1, token: "successor" });
  await withState(dir, async () => { writeFileSync(path.join(dir, "search.lock/owner"), successor); });
  assert.equal(readFileSync(path.join(dir, "search.lock/owner"), "utf8"), successor);
});

test("concurrent searches in one process serialize on the lock", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-lock-"));
  let inside = 0;
  let overlapped = false;
  const job = async () => {
    inside += 1;
    overlapped ||= inside > 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    inside -= 1;
  };
  await Promise.all([withState(dir, job), withState(dir, job), withState(dir, job)]);
  assert.equal(overlapped, false);
  rmSync(dir, { recursive: true, force: true });
});

test("budget exhaustion mid-search prints no partial ranking", async (t) => {
  const f = await fixture(t, (_req, res, parsed) => answer(res, parsed, MAX_INPUT_TOKENS));
  writeFileSync(f.config, JSON.stringify({ search_cap_usd: reservation * 1.5 }));
  const result = await f.run(Array.from({ length: 17 }, (_, i) => `login ${i}`).join("\n"));
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.equal(f.requests.length, 1);
});

test("corrupt accounting fails closed instead of resetting the daily spend", async (t) => {
  const f = await fixture(t);
  mkdirSync(path.join(f.dir, "state"));
  writeFileSync(path.join(f.dir, "state/spend.json"), "not json");
  const result = await f.run("login");
  assert.equal(result.code, 2);
  assert.equal(f.requests.length, 0);
});

test("a corrupt result cache is discarded and rebuilt instead of refusing searches", async (t) => {
  const f = await fixture(t);
  mkdirSync(path.join(f.dir, "state"));
  writeFileSync(path.join(f.dir, "state/cache.json"), "not json");
  const result = await f.run("login");
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "login\n");
  assert.equal(result.stderr.split("\n").filter((line) => line.includes("result cache")).length, 1);
  assert.match((await f.run("login")).stderr, /cache hit/);
  assert.equal(f.requests.length, 1);
});

test("config-relative paths work and zero caps permit an existing cache hit", async (t) => {
  const f = await fixture(t);
  const config = { key_file: "./key", redaction_file: "./redaction.json" };
  writeFileSync(f.config, JSON.stringify(config));
  const overrides = { JEVZF_KEY_FILE: "", JEVZF_REDACTION_FILE: "" };
  assert.equal((await f.run("login", "query", overrides)).code, 0);
  writeFileSync(f.config, JSON.stringify({ ...config, search_cap_usd: 0, daily_cap_usd: 0 }));
  assert.match((await f.run("login", "query", overrides)).stderr, /cache hit/);
  assert.equal((await f.run("login", "another query", overrides)).code, 2);
  assert.equal(f.requests.length, 1);
});

for (const status of [429, 529]) {
  test(`HTTP ${status} follows the SDK retry policy, honouring Retry-After`, async (t) => {
    const f = await fixture(t, (_req, res, _body, n) => {
      if (n === 1) { res.writeHead(status, { "Retry-After": "1" }); res.end("private error body"); return true; }
    });
    const began = Date.now();
    const result = await f.run("login");
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "login\n");
    assert.ok(Date.now() - began >= 1000);
    assert.equal(f.requests.length, 2);
  });

  test(`HTTP ${status} on every attempt fails after the SDK's retries without leaking the body`, async (t) => {
    const f = await fixture(t, (_req, res) => { res.writeHead(status, { "Retry-After": "0" }); res.end("private error body"); return true; });
    const result = await f.run("login");
    assert.equal(result.code, 2);
    assert.match(result.stderr, new RegExp(`HTTP ${status}`));
    assert.ok(!result.stderr.includes("private error body"));
    assert.equal(f.requests.length, 3);
  });
}

test("readable file paths reach Jev while long base64 and hex secrets are redacted", () => {
  const redactor = createRedactor();
  for (const line of ["./packages/i18n/src/translations/localeLoader.ts", "./src/components/dashboard/v2/widgets/chart_legend.tsx", "./docs/2024/meeting-notes/quarterly_planning_review.md"]) {
    assert.equal(redactor.redact(line), line);
  }
  assert.equal(redactor.redact("blob q8Zt3Kp/Wm4xR7vN2bYc+Hj9LsQe/1fGdA0uTkPiXo5E="), "blob [long token]");
  assert.equal(redactor.redact("sha 3f786850e387550fdab836ed7e6dc881de23001b"), "sha [long token]");
  assert.equal(redactor.redact("key JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"), "key [long token]");
  const readable = "home/user/projects/service/src/components/dashboard/widgets/charts/legend/items/labels/format/locale/strings/english/common/shared/";
  assert.equal(redactor.redact(`${readable}3f786850e387550fdab836ed7e6dc881de23001b`), "[long token]");
  assert.equal(redactor.redact(`${readable}q8Zt3Kp/Wm4xR7vN2bYc+Hj9LsQe/1fGdA0uTkPiXo5E=`), "[long token]");
});

test("optional redaction and the internal core use the same safe cached request path", async (t) => {
  const f = await fixture(t);
  const engine = createSearch({ env: { ...f.env, JEVZF_REDACTION_FILE: "" } });
  assert.equal(engine.enabled, true);
  const result = await engine.search({ query: "authentication", lines: ["login test@example.com", "garden"] });
  assert.deepEqual(result.lines, ["login test@example.com"]);
  assert.ok(!f.requests[0].body.includes("test@example.com"));
  assert.equal((await engine.search({ query: "authentication", lines: ["garden", "login test@example.com"] })).cached, true);
  assert.equal(f.requests.length, 1);
});

test("SDK environment settings cannot redirect credentials or turn on request logging", async (t) => {
  const f = await fixture(t);
  const result = await f.run("login Private Person", "authentication", { TYPESAFE_BASE_URL: "https://example.com", TYPESAFE_LOG_LEVEL: "debug", TYPESAFE_DEFAULT_MODEL: "other", TYPESAFE_API_KEY: "wrong" });
  assert.equal(result.code, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].authorization, "Bearer test-credential");
  assert.equal(f.requests[0].parsed.model, PINNED_MODEL);
  assert.ok(!result.stderr.includes("Private Person") && !result.stderr.includes("test-credential") && !result.stderr.includes("typesafe-sdk"));
});

test("spend environment overrides need no config and reject invalid amounts", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run("login", "query", { JEVZF_SEARCH_CAP_USD: "0" })).code, 2);
  assert.equal((await f.run("login", "query", { JEVZF_DAILY_CAP_USD: "not-a-number" })).code, 2);
  assert.equal(f.requests.length, 0);
});

test("malformed responses fail and are never cached", async (t) => {
  const f = await fixture(t, (_req, res) => { res.end(JSON.stringify({ model: PINNED_MODEL, answers: {}, usage: { input_tokens: 100 } })); return true; });
  assert.equal((await f.run("login")).code, 2);
  assert.equal((await f.run("login")).code, 2);
  assert.equal(f.requests.length, 2);
});

test("remote endpoint overrides and redirects cannot receive the credential", async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(307, { location: "/stolen" }); res.end(); return true; });
  const rejected = await f.run("login", "query", { JEVZF_JEV_ENDPOINT: "https://example.com/" });
  assert.equal(rejected.code, 2);
  assert.equal(f.requests.length, 0);
  const redirected = await f.run("login");
  assert.equal(redirected.code, 2);
  assert.equal(f.requests.length, 1);
});

test("invalid config, missing redaction, empty key and oversized input send nothing", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run("login", "query", { JEVZF_REDACTION_FILE: path.join(f.dir, "missing-redaction") })).code, 2);
  assert.equal((await f.run("login", "x".repeat(401))).code, 2);
  assert.equal((await f.run("a".repeat(24001))).code, 2);
  writeFileSync(f.config, JSON.stringify({ daily_cap_usd: -1 }));
  assert.equal((await f.run("login")).code, 2);
  writeFileSync(f.config, "{}");
  writeFileSync(f.key, "");
  assert.equal((await f.run("login")).code, 2);
  assert.equal(f.requests.length, 0);
});

test("stock fzf Ctrl-R reloads the original candidates and preserves semantic order", { skip: !supportedFzf || spawnSync("python3", ["--version"]).status !== 0 }, async (t) => {
  const f = await fixture(t);
  const bindir = path.join(f.dir, "bin");
  mkdirSync(bindir);
  symlinkSync(cli, path.join(bindir, "jevzf"));
  const input = path.join(f.dir, "input");
  const output = path.join(f.dir, "result");
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

test("help and version work without configuration; no matches return 1", async (t) => {
  const f = await fixture(t);
  assert.match((await f.run("", "", {}, ["--help"])).stdout, /Usage:/);
  assert.equal((await f.run("", "", {}, ["--version"])).stdout, "0.1.0\n");
  const result = await f.run("gardening");
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
});

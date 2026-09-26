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

const sentItems = (requests) => requests.flatMap((request) => Object.values(request.parsed.state.items));

test("readable file paths, including digit-bearing camelCase names and @2x assets, reach Jev unchanged", async (t) => {
  const f = await fixture(t);
  const paths = [
    "./packages/i18n/src/translations/localeLoader.ts",
    "./src/components/dashboard/v2/widgets/chart_legend.tsx",
    "./docs/2024/meeting-notes/quarterly_planning_review.md",
    "./src/components/Dashboard/v2/widgets/ChartLegend2Item.tsx",
    "./src/test/java/com/example/service/UserServiceImpl2Test.java",
    "./lib/utils/xmlHttpRequest/handlers/v1/parseHTTP2Response.js",
    "./test/fixtures/i18n/en-US/messages/errors/http404NotFound.json",
    "./src/encoding/encodeUtf8ToBase64Url/encodeUtf8ToBase64Url.ts",
    "./src/crypto/sha256Hmac/hmacSha256Digest.ts",
    "./vendor/github.com/aws/aws-sdk-go-v2/service/s3/api_op_PutObject.go",
    "./src/checkout/Step3ShippingAddress/Step3ShippingAddress.tsx",
    "./node_modules/typescript/lib/lib.es2015.collection.d.ts",
    "./ios/App/Assets.xcassets/AppIcon.appiconset/Icon-App-83.5x83.5@2x.png",
    "./public/images/logo@2x.png",
    "./migrations/20240115123456_add_user_profiles_table.sql",
    "./src/features/oauth2/components/OAuth2CallbackHandler.tsx",
    "./android/app/src/main/res/drawable-xxhdpi/ic_launcher_foreground.png",
    "./services/indexer_v3/internal/k8s/deployment_config_v1beta1.yaml",
    "./src/graphql/__generated__/GetUserProfileV2Query.graphql.ts",
    "./packages/ui/src/components/Grid/Grid12Column/Grid12ColumnLayout.stories.tsx"
  ];
  assert.equal(paths.length, 20);
  const kebab = ["./src/tasks/pk-generate-primary-key-migrations.ts", "./scripts/sk-learn-model-v2-evaluation.py", "./docs/rk-2024-release-notes-draft.md", "./src/sk-integration-test-fixtures/setup.ts", "./public/icons/icon@2x.PNG", "./public/images/hero@2x.avif"];
  assert.equal((await f.run([...paths, ...kebab].join("\n"))).code, 1);
  assert.deepEqual(sentItems(f.requests).sort(), [...paths, ...kebab].sort());
});

// Deterministic so a failure names the same generated key on every run
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("ten generated keys of every known format, in each provider's real shape, are all redacted", async (t) => {
  const f = await fixture(t);
  const random = seeded(20260925);
  const from = (alphabet) => (n) => Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const alnum = from(upper + upper.toLowerCase() + "0123456789");
  const b64url = from(upper + upper.toLowerCase() + "0123456789-_");
  const digits = from("0123456789");
  const upperDigits = from(upper + "0123456789");
  const hex = from("0123456789abcdef");
  const base64 = from(upper + upper.toLowerCase() + "0123456789+/");
  // Prefixes are split so the fake credentials never appear whole in the source
  const formats = [
    ["[api key]", () => "s" + "k-proj-" + b64url(156)],
    ["[api key]", () => "s" + "k-svcacct-" + b64url(156)],
    ["[api key]", () => "s" + "k-admin-" + b64url(156)],
    ["[api key]", () => "s" + "k-None-" + b64url(48)],
    ["[api key]", () => "s" + "k-ant-api03-" + b64url(93) + "AA"],
    ["[api key]", () => "s" + "k-ant-admin01-" + b64url(93) + "AA"],
    ["[api key]", () => "s" + "k-" + alnum(46) + "Q7"],
    ["[api key]", () => "s" + "k_live_" + alnum(99)],
    ["[api key]", () => "r" + "k_test_" + alnum(99)],
    ["[github token]", () => "gh" + "p_" + alnum(36)],
    ["[github token]", () => "gh" + "o_" + alnum(36)],
    ["[github token]", () => "gh" + "s_" + alnum(36)],
    ["[github token]", () => "github" + "_pat_" + alnum(22) + "_" + alnum(59)],
    ["[gitlab token]", () => "gl" + "pat-" + b64url(20)],
    ["[npm token]", () => "np" + "m_" + alnum(36)],
    ["[slack token]", () => "xo" + "xb-" + digits(12) + "-" + digits(13) + "-" + alnum(24)],
    ["[slack token]", () => "xo" + "xp-" + digits(12) + "-" + digits(12) + "-" + digits(13) + "-" + hex(32)],
    ["[slack token]", () => "xo" + "xa-2-" + digits(12) + "-" + alnum(24)],
    ["[aws key]", () => "AK" + "IA" + upperDigits(16)],
    ["[aws key]", () => "AS" + "IA" + upperDigits(16)],
    ["[google key]", () => "AI" + "za" + b64url(35)],
    ["[token]", () => "ey" + "J" + b64url(33) + "." + b64url(60) + "." + b64url(43)],
    ["[email]", () => alnum(8).toLowerCase() + "@" + digits(3) + ".com"],
    ["[github token]", () => "gh" + "u_" + alnum(36)],
    ["[github token]", () => "gh" + "r_" + alnum(76)],
    ["Bearer [token]", () => "Bearer " + b64url(40)],
    ["Authorization: [redacted]", () => "Authorization: Basic " + base64(30) + "=="],
    ["https://[redacted]@example.com/path", () => "https://" + alnum(6).toLowerCase() + ":" + alnum(20) + "@example.com/path"],
    ["postgres://[redacted]@db:5432/app", () => "postgres://app:" + alnum(24) + "@db:5432/app"]
  ];
  const cases = formats.flatMap(([replacement, make]) => Array.from({ length: 10 }, () => [make(), replacement]));
  assert.ok(cases.some(([key]) => key.startsWith("s" + "k-proj-") && /-.*-/.test(key.slice(8))));
  const lines = cases.map(([key], i) => `login ${i} ${key}`);
  const result = await f.run(lines.join("\n"));
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout.trim().split("\n").sort(), [...lines].sort());
  assert.deepEqual(sentItems(f.requests).sort(), cases.map(([, replacement], i) => `login ${i} ${replacement}`).sort());
  for (const [key] of cases) assert.ok(f.requests.every((request) => !request.body.includes(key)), key);
});

test("code lines keep everything but a secret's value", async (t) => {
  const f = await fixture(t);
  const unchanged = [
    "function login(token: string, user: User) {",
    '{ key: item.id, label: "Save" }',
    "items.map((key) => cache.get(key));",
    "items.map(key => key.id)",
    "export interface Session { token: string; expiresAt: Date }",
    "const { password, ...rest } = user;",
    'if (!token) throw new Error("missing token");',
    "def verify(password: str, hashed: bytes) -> bool:",
    "    token: Optional[str] = None",
    "api_key: ${{ secrets.OPENAI_API_KEY }}",
    "  password: ${DB_PASSWORD}",
    "type Props = { apiKey: string; onChange: (key: string) => void };",
    "const secretName = process.env.SECRET_NAME;",
    'logger.info("token refreshed", { userId });',
    "password_reset_url: /account/reset",
    "const tokenCount = tokens.length;",
    "- name: Rotate API key",
    "if (password.length < 12) return false;",
    "  key: user-profile-panel",
    '@app.post("/token")',
    'return jwt.encode(payload, key, algorithm="HS256")',
    "password_hash = bcrypt.hash(password, rounds)",
    "for key, value in settings.items():",
    "  - key: ENVIRONMENT",
    "password = get_password()",
    "const token = await fetchToken(user)",
    "token = getToken();",
    "api_key = os.environ['API_KEY']",
    "if (token === expectedToken) {",
    "const tokenCount = 5",
    "monkey=banana tokens=5 keyboard=qwerty"
  ];
  const secret = [
    ['const password = "hunter2secret";', 'const password = "[redacted]";'],
    ["DB_PASSWORD=hunter2hunter2", "DB_PASSWORD=[redacted]"],
    ["password: hunter2secret99", "password: [redacted]"],
    ['secret: "two words here"', 'secret: "[redacted]"'],
    ['{"token": "abc def", "user": "zed"}', '{"token": "[redacted]", "user": "zed"}'],
    ["api_key=xyz", "api_key=[redacted]"],
    ["'password' => 'hunter2secret',", "'password' => '[redacted]',"],
    [':password => "rubysecret"', ':password => "[redacted]"'],
    ['if (password === "hunter2secret") {', 'if (password === "[redacted]") {'],
    ['if (password !== "x") {', 'if (password !== "[redacted]") {'],
    ['password != "x"', 'password != "[redacted]"'],
    ["password = `hunter2 secret` + suffix", "password = `[redacted]` + suffix"],
    ["DB_PASSWORD=abc;def'ghi", "DB_PASSWORD=[redacted]'ghi"],
    ["password=[bracketed]secret", "password=[redacted]"],
    ['password="unterminated secret', 'password="[redacted]"'],
    ['"password": "ab\\"cdsecret"', '"password": "[redacted]"'],
    ["{ key: 'settings', label: t('nav.settings') }", "{ key: '[redacted]', label: t('nav.settings') }"],
    ['sortKey: "createdAt",', 'sortKey: "[redacted]",'],
    ["{password=abc123}", "{password=[redacted]}"],
    ["--token=abc123 --verbose", "--token=[redacted] --verbose"],
    ["SECRET_KEY_BASE=3f4a9c1e8b7d6a5f4e3d2c1b0a9f8e7d", "SECRET_KEY_BASE=[redacted]"],
    ["DB_PASSWORD_PROD=hunter2hunter2", "DB_PASSWORD_PROD=[redacted]"],
    ["API_KEY_V2=abcd1234efgh", "API_KEY_V2=[redacted]"],
    ["GITHUB_TOKEN_READONLY=abc123def456", "GITHUB_TOKEN_READONLY=[redacted]"],
    ['password_confirmation: "hunter2"', 'password_confirmation: "[redacted]"'],
    ['const apiKey = "xyz";', 'const apiKey = "[redacted]";'],
    ["export OPENAI_API_KEY=" + "s" + "k-proj-" + "a1B2-c3D4_e5F6-g7H8i9J0", "export OPENAI_API_KEY=[redacted]"]
  ];
  assert.ok(unchanged.length + secret.length >= 30);
  await f.run([...unchanged, ...secret.map(([line]) => line)].join("\n"));
  assert.deepEqual(sentItems(f.requests).sort(), [...unchanged, ...secret.map(([, sent]) => sent)].sort());
});

for (const [name, kind, terminated] of [
  ["a private key piped as lines spanning batches", "RSA PRIVATE KEY", true],
  ["a private key cut off before its END line", "RSA PRIVATE KEY", false],
  ["a PGP private key block piped as lines", "PGP PRIVATE KEY BLOCK", true]
]) {
  test(`${name} sends none of its body lines`, async (t) => {
    const f = await fixture(t);
    const body = Array.from({ length: 30 }, (_, i) => `${String.fromCharCode(65 + (i % 26))}${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC".slice(0, 40)}${i}`);
    const block = [`-----BEGIN ${kind}-----`, ...body, ...(terminated ? [`-----END ${kind}-----`] : [])];
    const filler = Array.from({ length: 20 }, (_, i) => `login ${i}`);
    const result = await f.run([...filler.slice(0, 10), ...block, ...filler.slice(10)].join("\n"));
    assert.equal(result.code, 0);
    assert.ok(f.requests.length > 2);
    const sent = sentItems(f.requests);
    assert.equal(sent.filter((item) => item === "[private key]").length, terminated ? block.length : block.length + 10);
    for (const line of block) assert.ok(f.requests.every((request) => !request.body.includes(line)));
  });
}

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

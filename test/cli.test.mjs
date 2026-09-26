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
  const configure = (settings) => writeFileSync(config, JSON.stringify({ key_file: key, ...settings }));
  configure({});
  const env = {
    PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir,
    JEVZF_CONFIG: config, JEVZF_STATE_DIR: path.join(dir, "state"),
    JEVZF_NEVER_SEND_FILE: redaction,
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
  return { dir, requests, run, env, config, configure, key, redaction, ledger, ledgerFile };
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
  f.configure({ spend: { per_day_usd: reservation + usdFor(100) / 2 } });
  assert.equal((await f.run("login\n")).code, 0);
  const capped = await f.run("login\n", "different query");
  assert.equal(capped.code, 2);
  assert.match(capped.stderr, /today's spend ceiling cannot cover one request, which reserves USD 0\.0028; nothing was sent/);
  assert.equal((await f.run("login\n")).code, 0);
  assert.equal(f.requests.length, 1);
});

test("a cached repeat estimates nothing to send and does not warn about its ceiling", async (t) => {
  const f = await fixture(t);
  f.configure({ spend: { per_search_usd: reservation } });
  assert.match((await f.run("login\n")).stderr, /this search may need more than its USD [0-9.]+ ceiling/);
  const repeat = await f.run("login\n");
  assert.equal(repeat.code, 0);
  assert.equal(repeat.stderr, "");
  assert.match((await f.run("login\nreset\n", "", {}, ["--estimate", "authentication"])).stdout, /^2 lines · 1 cached · about USD 0\.0000\d+ · /);
  assert.match((await f.run("login\n", "", {}, ["--estimate", "authentication"])).stdout, /^1 lines · 1 cached · about USD 0\.00 · /);
  assert.match((await f.run("login\n", "", {}, ["--estimate", "--no-cache", "authentication"])).stdout, /^1 lines · 0 cached · /);
  assert.equal(f.requests.length, 1);
});

test("key sources are the config key_file or TYPESAFE_API_KEY, never a JEVZF_KEY_FILE variable", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.config, "{}");
  const ignored = await f.run("login\n", "authentication", { JEVZF_KEY_FILE: f.key });
  assert.equal(ignored.code, 2);
  assert.match(ignored.stderr, /needs a TypeSafe API key/);
  assert.equal((await f.run("login\n", "authentication", { TYPESAFE_API_KEY: "test-credential" })).code, 0);
  assert.equal(f.requests.length, 1);
});

test("simultaneous CLI processes cannot allocate the same daily allowance", async (t) => {
  const f = await fixture(t, async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  f.configure({ spend: { per_day_usd: reservation, per_search_usd: reservation } });
  const results = await Promise.all([f.run("login\n", "query one"), f.run("login\n", "query two")]);
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 2]);
  assert.equal(f.requests.length, 1);
});

test("uncertain failures consume their reservation and retries cannot exceed the cap", async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(503); res.end("private provider error"); return true; });
  f.configure({ spend: { per_search_usd: reservation, per_day_usd: reservation } });
  const result = await f.run("login\n");
  assert.equal(result.code, 2);
  assert.equal(f.requests.length, 1);
  assert.ok(!result.stderr.includes("private provider error"));
  assert.equal(f.ledger().at(-1).usd, reservation);
  assert.equal((await f.run("login\n")).code, 2);
  assert.equal(f.requests.length, 1);
});

test("a process killed after sending leaves its reservation and does not retain a network-duration lock", async (t) => {
  let arrived;
  const received = new Promise((resolve) => { arrived = resolve; });
  const f = await fixture(t, () => { arrived(); return true; });
  f.configure({ spend: { per_day_usd: reservation } });
  const child = spawn(process.execPath, [cli, "query"], { env: f.env, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end("login\n");
  await received;
  const closed = new Promise((resolve) => child.on("close", resolve));
  child.kill("SIGKILL");
  await closed;
  assert.equal(f.ledger().at(-1).usd, reservation);
  assert.equal((await f.run("login\n")).code, 2);
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
  const refused = await f.run("login\n", "different", { JEVZF_PER_SEARCH_USD: "0" });
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /this search's spend ceiling cannot cover one request/);
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
  f.configure({ spend: { per_day_usd: -1 } });
  assert.equal((await f.run("login\n")).code, 2);
  f.configure({});
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
  f.configure({});
  assert.equal((await f.run("gardening\n")).code, 1);
});

// Redaction contracts carried from the first release's review rounds
const sentItems = (requests) => requests.flatMap((request) => Object.values(request.parsed.state.items));
// Identical redacted lines share one judgment, so each distinct text is sent once
const distinct = (items) => [...new Set(items)].sort();

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
    "const tokenCount = tokens.length;",
    "- name: Rotate API key",
    "if (password.length < 12) return false;",
    '@app.post("/token")',
    'return jwt.encode(payload, key, algorithm="HS256")',
    "password_hash = bcrypt.hash(password, rounds)",
    "for key, value in settings.items():",
    "  - key: ENVIRONMENT",
    "api_key=xyz",
    "password = get_password()",
    "const token = await fetchToken(user)",
    "token = getToken();",
    "api_key = os.environ['API_KEY']",
    "if (token === expectedToken) {",
    "monkey=banana tokens=5 keyboard=qwerty"
  ];
  const secret = [
    ['const password = "hunter2secret";', 'const password = "[redacted]";'],
    ["DB_PASSWORD=hunter2hunter2", "DB_PASSWORD=[redacted]"],
    ["password: hunter2secret99", "password: [redacted]"],
    ['secret: "two words here"', 'secret: "[redacted]"'],
    ['{"token": "abc def", "user": "zed"}', '{"token": "[redacted]", "user": "zed"}'],
    ["api_key=xyz9", "api_key=[redacted]"],
    ["'password' => 'hunter2secret',", "'password' => '[redacted]',"],
    [':password => "rubysecret"', ':password => "[redacted]"'],
    ['if (password === "hunter2secret") {', 'if (password === "[redacted]") {'],
    ['if (password !== "x") {', 'if (password !== "[redacted]") {'],
    ['password != "x"', 'password != "[redacted]"'],
    ["password = `hunter2 secret` + suffix", "password = `[redacted]` + suffix"],
    ["DB_PASSWORD=abc;def'ghi", "DB_PASSWORD=[redacted]"],
    ["password=abc)def", "password=[redacted]"],
    ["KEY=val}ue", "KEY=[redacted]"],
    ["password_reset_url: /account/reset", "password_reset_url: [redacted]"],
    ["  key: user-profile-panel", "  key: [redacted]"],
    ["const tokenCount = 5", "const tokenCount = [redacted]"],
    ["DBPassword=hunter2", "DBPassword=[redacted]"],
    ["APIToken=abc1", "APIToken=[redacted]"],
    ["APIKey=abc1", "APIKey=[redacted]"],
    ["JWTSecret=abc1", "JWTSecret=[redacted]"],
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
  assert.deepEqual(distinct(sentItems(f.requests)), distinct([...unchanged, ...secret.map(([, sent]) => sent)]));
});

test("credentials in real config formats lose their values while code references pass", async (t) => {
  const f = await fixture(t);
  // Synthetic values in each file format, never real credentials
  const cases = [
    ["[default]", "[default]"],
    ["aws_access_key_id = " + "AK" + "IA" + "Q2W3E4R5T6Y7U8I9", "aws_access_key_id = [redacted]"],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "aws_secret_access_key = [redacted]"],
    ["password = pypi-AgEIcHlwaS5vcmcCJDk", "password = [redacted]"],
    ["[client]", "[client]"],
    ["password = hunter2", "password = [redacted]"],
    ["DATABASE_PASSWORD=s3cr3t-Pa55", "DATABASE_PASSWORD=[redacted]"],
    ["SECRET_KEY_BASE=3f4a9c1e8b7d6a5f4e3d2c1b0a9f8e7d", "SECRET_KEY_BASE=[redacted]"],
    ['    "DBPassword": "hunter2",', '    "DBPassword": "[redacted]",'],
    ['    "ApiKey": "abc123-def456",', '    "ApiKey": "[redacted]",'],
    ['    "ClientSecret": "Zm9vYmFy"', '    "ClientSecret": "[redacted]"'],
    ['api_token = "tok_2f9c8e7a"', 'api_token = "[redacted]"'],
    ["token = abc123def456", "token = [redacted]"],
    ["export GITHUB_TOKEN_READONLY=abc123def456", "export GITHUB_TOKEN_READONLY=[redacted]"],
    ["mycli deploy --token=abc123 --verbose", "mycli deploy --token=[redacted] --verbose"],
    ["connect(host=h, password=pw, user=u)", "connect(host=h, password=pw, user=u)"],
    ["Client(api_key=api_key)", "Client(api_key=api_key)"],
    ["Client(api_key='x-live-1')", "Client(api_key='[redacted]')"],
    ["connect(password=abc123, timeout=5)", "connect(password=[redacted], timeout=5)"]
  ];
  await f.run(cases.map(([line]) => line).join("\n"));
  assert.deepEqual(distinct(sentItems(f.requests)), distinct(cases.map(([, sent]) => sent)));
});

for (const [name, kind, terminated, prefix] of [
  ["a private key piped as lines spanning batches", "RSA PRIVATE KEY", true, () => ""],
  ["a private key cut off before its END line, as by head", "RSA PRIVATE KEY", false, () => ""],
  ["a PGP private key block with armour headers and a blank line", "PGP PRIVATE KEY BLOCK", true, () => ""],
  ["a private key in rg -n output", "RSA PRIVATE KEY", true, (i) => `keys/id_rsa:${i + 1}:`],
  ["a private key in rg -n output under a path with spaces", "RSA PRIVATE KEY", true, (i) => `Google Drive/keys/server.pem:${i + 1}:`],
  ["a private key in rg -C context lines", "RSA PRIVATE KEY", true, (i) => i === 0 ? "keys/a.pem:1:" : `keys/a.pem-${i + 1}-`],
  ["a cut-off private key in rg -n output", "OPENSSH PRIVATE KEY", false, (i) => `keys/id_ed25519:${i + 1}:`],
  ["a private key added in git diff output", "RSA PRIVATE KEY", true, () => "+"],
  ["a private key in cat -n output", "EC PRIVATE KEY", true, (i) => `${String(i + 1).padStart(6)}\t`],
  ["a PGP key block in rg -n output with a blank armour line", "PGP PRIVATE KEY BLOCK", true, (i) => `keys/sub.asc:${i + 1}:`]
]) {
  test(`${name} sends none of its key text, keeps each prefix and leaves later lines alone`, async (t) => {
    const f = await fixture(t);
    const body = Array.from({ length: 30 }, (_, i) => `${String.fromCharCode(65 + (i % 26))}${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC".slice(0, 40)}${i}`);
    const pgp = kind.startsWith("PGP");
    const key = [
      `-----BEGIN ${kind}-----`,
      ...(pgp ? ["Version: GnuPG v2", ""] : []),
      ...body,
      ...(terminated ? ["AQAB==", ...(pgp ? ["=Xk2a"] : []), `-----END ${kind}-----`] : [])
    ];
    const block = key.map((line, i) => prefix(i) + line);
    const filler = Array.from({ length: 20 }, (_, i) => `login ${i}`);
    const result = await f.run([...filler.slice(0, 10), ...block, ...filler.slice(10)].join("\n"));
    assert.equal(result.code, 0);
    // The input spans more than two 16-line batches; identical redacted lines are then sent once
    assert.ok(block.length + filler.length > 2 * 16);
    const expected = key.flatMap((line, i) => line ? [prefix(i) + "[private key]"] : prefix(i).trim() ? [prefix(i)] : []);
    assert.deepEqual(distinct(sentItems(f.requests).filter((item) => !item.startsWith("login"))), distinct(expected));
    assert.deepEqual(distinct(sentItems(f.requests).filter((item) => item.startsWith("login"))), distinct(filler));
    for (const line of key.filter((line) => line.length > 8)) assert.ok(f.requests.every((request) => !request.body.includes(line)), line);
  });
}

for (const [name, open, close, prefix] of [
  ["a multi-line .env value", 'PRIVATE_KEY="', '"', () => ""],
  ["a multi-line .env value in rg -n output", 'PRIVATE_KEY="', '"', (i) => `.env:${i + 4}:`],
  ["a Python triple-quoted string", 'SIGNING_KEY = """', '"""', () => ""],
  ["a JS template literal", "const key = `", "`", () => ""],
  ["a Go raw string", "var testKey = `", "`", () => ""],
  ["a JS template literal closed by a statement end", "const key = `", "`;", () => ""],
  ["a Python triple-quoted call argument", 'key = load_pem_private_key(b"""', '""")', () => ""],
  ["a Go test-table raw string", "{pem: `", "`,", () => ""]
]) {
  test(`a private key in ${name} sends none of its key text`, async (t) => {
    const f = await fixture(t);
    const body = Array.from({ length: 30 }, (_, i) => `${String.fromCharCode(65 + (i % 26))}${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC".slice(0, 40)}${i}`);
    const key = [`${open}-----BEGIN RSA PRIVATE KEY-----`, ...body, "AQAB==", `-----END RSA PRIVATE KEY-----${close}`];
    const filler = Array.from({ length: 20 }, (_, i) => `login ${i}`);
    await f.run([...filler.slice(0, 10), ...key.map((line, i) => prefix(i) + line), ...filler.slice(10)].join("\n"));
    const sent = sentItems(f.requests);
    const opening = sent.filter((item) => item.startsWith(prefix(0) + open.split(/\s|=/)[0]));
    assert.equal(opening.length, 1);
    assert.ok(!opening[0].includes("BEGIN"), opening[0]);
    const rest = key.slice(1).map((_, i) => `${prefix(i + 1)}[private key]`);
    assert.deepEqual(distinct(sent.filter((item) => !item.startsWith("login") && item !== opening[0])), distinct(rest));
    assert.deepEqual(distinct(sent.filter((item) => item.startsWith("login"))), distinct(filler));
    for (const line of body) assert.ok(f.requests.every((request) => !request.body.includes(line)), line);
  });
}

test("a private key held on one line with escaped newlines is redacted from BEGIN through END", async (t) => {
  const f = await fixture(t);
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC";
  await f.run(`login {"pem": "-----BEGIN PRIVATE KEY-----\\n${body}\\nAQAB==\\n-----END PRIVATE KEY-----\\n", "user": "zed"}`);
  assert.deepEqual(sentItems(f.requests), ['login {"pem": "[private key]\\n", "user": "zed"}']);
  assert.ok(f.requests.every((request) => !request.body.includes(body)));
});

test("a private-key marker held in a string constant does not blank the lines after it", async (t) => {
  const f = await fixture(t);
  const lines = [
    "src/pem.ts:1:// Headers for detecting key files",
    'src/pem.ts:3:const HEADER = "-----BEGIN RSA PRIVATE KEY-----";',
    "src/login.ts:1:export function signIn(user) {",
    "src/login.ts:2:  return login(user);"
  ];
  await f.run(lines.join("\n"));
  assert.deepEqual(sentItems(f.requests).sort(), [
    "src/pem.ts:1:// Headers for detecting key files",
    'src/pem.ts:3:const HEADER = "[private key]',
    "src/login.ts:1:export function signIn(user) {",
    "src/login.ts:2:  return login(user);"
  ].sort());
});

test("a large input that hits today's ceiling mid-search prints what it found and names the ceiling", async (t) => {
  const f = await fixture(t);
  // Room for the first few requests only, as when earlier searches spent most of today's allowance
  f.configure({ spend: { per_day_usd: reservation + 3 * usdFor(100) } });
  const lines = Array.from({ length: 200 }, (_, i) => i % 20 === 0 ? `login ${i}` : `garden ${i}`);
  const result = await f.run(`${lines.join("\n")}\n`);
  assert.equal(result.code, 0);
  const judged = f.requests.flatMap((request) => Object.values(request.parsed.state.items));
  assert.ok(f.requests.length >= 3 && f.requests.length < 13, `${f.requests.length} requests`);
  assert.deepEqual(result.stdout.trim().split("\n"), lines.filter((line) => line.startsWith("login") && judged.includes(line)));
  assert.match(result.stderr, /this search may need more than the USD [0-9.]+ left today; lines past it go unjudged, in input order/);
  assert.match(result.stderr, new RegExp(`stopped at today's spend ceiling; ${200 - judged.length} lines unjudged \\(input order\\)`));
  assert.ok(f.ledger().at(-1).closed);
});

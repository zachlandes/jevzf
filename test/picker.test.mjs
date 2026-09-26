import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, truncateSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_MODEL } from "../lib/meaning/jev.mjs";
import { openJev, searchByMeaning } from "../lib/core.mjs";
import { act, EXACT_SHELL, exactTerms, fitWidth, glyphs, header, summary } from "../lib/picker/view.mjs";
import { handleKey, headerInfo, saveState, loadState, inputFile, endFile, QUEUED_SHELL } from "../lib/picker/keys.mjs";
import { findFzf, fzfEnv } from "../lib/picker/run.mjs";

const cli = fileURLToPath(new URL("../bin/jevzf.mjs", import.meta.url));
const driver = fileURLToPath(new URL("./pty-driver.py", import.meta.url));
const utf8 = { LANG: "en_US.UTF-8" };

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-picker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("header lines fit the fzf width at 60, 76 and 120 columns and keep the key hint whole", () => {
  const state = { mode: "meaning", phase: "ask" };
  const estimate = { lines: 1204, estimatedUsd: 0.012, perSearchUsd: 0.02, remainingUsd: 0.18 };
  for (const columns of [60, 76, 120]) {
    const env = { ...utf8, FZF_COLUMNS: String(columns) };
    for (const info of [{ estimate }, { problem: `Meaning search needs a TypeSafe key ${glyphs(env).dot} export TYPESAFE_API_KEY` }]) {
      const lines = header({ state, env, info }).split("\n");
      for (const line of lines) assert.ok(line.replace(/\x1b\[[0-9;]*m/g, "").length <= columns - 2, `${columns}: ${line}`);
      if (info.problem) assert.ok(lines.some((line) => line.includes("export TYPESAFE_API_KEY")));
    }
  }
  const wide = header({ state, env: { ...utf8, FZF_COLUMNS: "120" }, info: { estimate } }).split("\n");
  assert.equal(wide[2], "about USD 0.012 · never more than USD 0.02 per search · USD 0.18 left today");
  assert.deepEqual(fitWidth("abcdefghij", 4, "·"), ["abcd", "efgh", "ij"]);
});

test("glyphs fall back to ASCII without a UTF-8 locale, and NO_COLOR marks the mode in brackets", () => {
  assert.equal(glyphs({ LC_ALL: "C" }).dot, "|");
  assert.equal(glyphs({ LANG: "en_US.UTF-8" }).dot, "·");
  const plain = header({ state: { mode: "exact", phase: "ask" }, env: { NO_COLOR: "1" } });
  assert.ok(plain.startsWith(" fuzzy  [exact]  meaning "));
  assert.ok(!plain.includes("\x1b"));
  assert.ok(header({ state: { mode: "exact", phase: "ask" }, env: {} }).includes("\x1b[1;7m exact \x1b[0m"));
  const text = summary({ matches: [1, 2], lines: 1204, stopped: true, unjudged: 20, failed: 0, fallback: false, seconds: 1.94, spend: 0.0118, cached: false }, "retry", glyphs({}));
  assert.equal(text, "\"retry\": 2 found in 1,204 lines | stopped at the spend ceiling; 20 lines unjudged\t1.9 s | USD 0.0118");
  const soFar = { matches: [1], lines: 5, partial: true, stopped: false, failed: 0, seconds: 0.5, spend: 0, cached: false };
  assert.match(summary({ ...soFar, fallback: false }, "retry", glyphs({})), /^"retry": 1 found in the first 5 lines so far\t/);
  assert.match(summary({ ...soFar, fallback: true }, "retry", glyphs({})), /^nothing clearly matched "retry" in the first 5 lines so far; the 1 closest are shown\t/);
  const results = (columns) => header({ state: { mode: "meaning", phase: "results" }, env: { ...utf8, FZF_COLUMNS: String(columns) }, info: { summary: "“retry logic”: 3 found in 20 lines\t0.6 s · USD 0.000252" } }).split("\n");
  assert.equal(results(120)[1], "“retry logic”: 3 found in 20 lines · 0.6 s · USD 0.000252");
  assert.deepEqual(results(50).slice(1, 3), ["“retry logic”: 3 found in 20 lines", "0.6 s · USD 0.000252"]);
});

test("fzf actions choose a bracket their argument lacks, and exact mode quotes plain words", () => {
  assert.equal(act("change-query", "a (b)"), "change-query[a (b)]");
  assert.equal(act("change-prompt", "x\ny"), "change-prompt(x y)");
  assert.equal(exactTerms("retry  'done ^start !not | or"), "'retry 'done ^start !not | 'or");
  const shell = spawnSync("sh", ["-c", EXACT_SHELL], { env: { FZF_QUERY: "retry  'done ^start !not | or" }, encoding: "utf8" });
  assert.equal(shell.stdout, exactTerms("retry  'done ^start !not | or"));
});

function keyFixture(t, env = {}) {
  const dir = scratch(t);
  const home = path.join(dir, "home");
  writeFileSync(inputFile(dir), "retry failed uploads\nbump deps\n");
  writeFileSync(endFile(dir), "");
  saveState(dir, { mode: "fuzzy", phase: "ask", words: "", gen: 0, summary: null, progress: null, options: { floor: 0.58, closest: 3, noCache: false, read0: false } });
  const base = { ...utf8, FZF_COLUMNS: "100", XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home, ...env };
  return { dir, key: (name, query = "") => handleKey(dir, name, { ...base, FZF_QUERY: query }) };
}

test("mode keys keep the typed words, and meaning shows every line with search off", async (t) => {
  const f = keyFixture(t, { TYPESAFE_API_KEY: "fixture-only" });
  const exact = await f.key("cycle", "retry up");
  assert.match(exact, /^change-prompt\(exact> \)\+enable-search\+rebind\(change\)\+change-query\(retry up\)\+search\('retry 'up\)/);
  const meaning = await f.key("cycle", "retry up");
  // An earlier search(...) outlives disable-search, and disable-search must precede the reload
  assert.match(meaning, /unbind\(change\)\+search\(\)\+disable-search\+reload\([^)]+ list\)\+change-query\(retry up\)/);
  assert.match(meaning, /Type what you mean, then press enter · 2 lines/);
  assert.equal(await f.key("meaning", "retry up"), "ignore");
  assert.equal(loadState(f.dir).mode, "meaning");
});

test("enter queues one meaning search behind an emptied list, and results give the words back", async (t) => {
  const f = keyFixture(t, { TYPESAFE_API_KEY: "fixture-only" });
  await f.key("meaning");
  assert.equal(await f.key("enter", "   "), "ignore");
  const enter = await f.key("enter", "why uploads fail");
  assert.match(enter, /change-prompt\(filter> \)[\s\S]*change-query\(\)\+enable-search\+reload\(true\)$/);
  const state = loadState(f.dir);
  assert.equal(state.phase, "running");
  assert.equal(state.words, "why uploads fail");
  const queued = spawnSync("sh", ["-c", QUEUED_SHELL], { env: { JEVZF_PICKER_DIR: f.dir }, encoding: "utf8" });
  assert.match(queued.stdout, new RegExp(`^reload\\(.*child\\.mjs' search ${state.gen}\\)$`));
  assert.equal(spawnSync("sh", ["-c", QUEUED_SHELL], { env: { JEVZF_PICKER_DIR: f.dir }, encoding: "utf8" }).stdout, "");
  assert.equal(await f.key("enter", "narrowing"), "accept");
  const back = await f.key("fuzzy", "narrowing");
  assert.match(back, /reload\([^)]+ list\)\+change-query\(why uploads fail\)/);
});

test("without a key, meaning mode says what to export and enter sends nothing", async (t) => {
  const f = keyFixture(t, { TYPESAFE_API_KEY: "" });
  assert.match(await f.key("meaning", "retry"), /Meaning search needs a TypeSafe key · export TYPESAFE_API_KEY/);
  const enter = await f.key("enter", "retry");
  assert.match(enter, /^change-header\(/);
  assert.equal(loadState(f.dir).phase, "ask");
  assert.ok(!existsSync(path.join(f.dir, "queued")));
});

test("the header takes the terminal's own foreground, ahead of fzf defaults the user set", (t) => {
  const dir = scratch(t);
  assert.equal(fzfEnv({}, dir).FZF_DEFAULT_OPTS, "--color=header:-1");
  assert.equal(fzfEnv({ FZF_DEFAULT_OPTS: "--color=header:red" }, dir).FZF_DEFAULT_OPTS, "--color=header:-1 --color=header:red");
  const theirs = path.join(dir, "theirs");
  writeFileSync(theirs, "--color=light\n");
  const env = fzfEnv({ FZF_DEFAULT_OPTS_FILE: theirs, FZF_DEFAULT_OPTS: "--border" }, dir);
  assert.equal(readFileSync(env.FZF_DEFAULT_OPTS_FILE, "utf8"), "--color=header:-1\n--color=light\n");
  assert.equal(env.FZF_DEFAULT_OPTS, "--border");
  assert.deepEqual(fzfEnv({ FZF_DEFAULT_OPTS_FILE: path.join(dir, "missing") }, dir), { FZF_DEFAULT_OPTS_FILE: path.join(dir, "missing") });
});

test("the picker refuses fzf older than 0.66 or missing, naming the fix", (t) => {
  const dir = scratch(t);
  const fake = path.join(dir, "fzf");
  writeFileSync(fake, "#!/bin/sh\necho '0.65.2 (fake)'\n");
  chmodSync(fake, 0o755);
  assert.throws(() => findFzf({ JEVZF_FZF: fake }), /needs fzf 0\.66 or newer, found 0\.65\.2; install it with brew install fzf/);
  assert.throws(() => findFzf({ JEVZF_FZF: path.join(dir, "missing") }), /none was found/);
  writeFileSync(fake, "#!/bin/sh\necho '0.66.0 (fake)'\n");
  assert.equal(findFzf({ JEVZF_FZF: fake }), fake);
  const cliRun = spawnSync(process.execPath, [cli], { input: "a\n", env: { PATH: process.env.PATH, JEVZF_FZF: path.join(dir, "missing") }, encoding: "utf8" });
  assert.equal(cliRun.status, 2);
  assert.match(cliRun.stderr, /use the filter: cmd \| jevzf QUERY/);
});

// Real fzf in a PTY: JEVZF_FZF when set (CI points it at each supported release), else PATH
const fzfPath = process.env.JEVZF_FZF || "fzf";
let usableFzf = spawnSync("python3", ["--version"]).status === 0;
try { findFzf({ ...process.env, JEVZF_FZF: fzfPath }); } catch { usableFzf = false; }

async function standIn(t, { hold = false } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    // Never answers, so only the picker can end the search
    if (hold) return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: PINNED_MODEL, answers: Object.fromEntries(Object.entries(request.state.items).map(([id, text]) => [id, { type: "noul", noul: text.includes("retry") ? 0.95 : text.includes("backoff") ? 0.8 : 0.1 }])), usage: { input_tokens: 100 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/systemone` };
}

// Input given as [[when, text], ...] comes from a slow producer that sends each part after a delay
// in seconds, or once a ["touch", when] step has created a gate file of that name
function picker(t, { steps, env = {}, input, args = [], home }) {
  const dir = scratch(t);
  home ??= dir;
  const parts = Array.isArray(input) ? input : [[0, input]];
  parts.forEach(([, text], i) => writeFileSync(path.join(dir, `input.${i}`), text));
  const result = path.join(dir, "result");
  const after = (when) => (typeof when === "string" ? `until [ -e '${path.join(dir, when)}' ]; do sleep 0.05; done` : `sleep ${when}`);
  const source = `(${parts.map(([when], i) => `${after(when)}; cat '${path.join(dir, `input.${i}`)}'`).join("; ")}) |`;
  return new Promise((resolve) => {
    const child = spawn("python3", [driver], {
      env: {
        PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home, TERM: "xterm-256color", LANG: "en_US.UTF-8",
        JEVZF_FZF: fzfPath, FZF_DEFAULT_OPTS: "", STEPS: JSON.stringify(steps), GATE_DIR: dir,
        COMMAND: `${source} ${[process.execPath, cli, ...args].map((part) => `'${part}'`).join(" ")} > '${result}'`,
        ...env
      }
    });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("close", (code) => resolve({ code, stderr, output: existsSync(result) ? readFileSync(result, "utf8") : "" }));
  });
}

const ENTER = "\r", ESC = "\x1b";

test("under --no-cache the meaning header prices lines an earlier search cached", async (t) => {
  const s = await standIn(t);
  const f = keyFixture(t, { TYPESAFE_API_KEY: "fixture-only", JEVZF_JEV_ENDPOINT: s.endpoint });
  const env = { ...utf8, XDG_CONFIG_HOME: path.join(f.dir, "home"), XDG_STATE_HOME: path.join(f.dir, "home"), XDG_CACHE_HOME: path.join(f.dir, "home"), TYPESAFE_API_KEY: "fixture-only", JEVZF_JEV_ENDPOINT: s.endpoint };
  await searchByMeaning({ jev: openJev({ env }), query: "why uploads fail", items: ["retry failed uploads", "bump deps"] });
  const state = { ...loadState(f.dir), mode: "meaning" };
  const cached = await headerInfo(f.dir, state, env, "why uploads fail");
  assert.equal(cached.estimate.cachedLines, 2);
  assert.equal(cached.estimate.estimatedUsd, 0);
  const fresh = await headerInfo(f.dir, { ...state, options: { ...state.options, noCache: true } }, env, "why uploads fail");
  assert.equal(fresh.estimate.cachedLines, 0);
  assert.ok(fresh.estimate.estimatedUsd > 0);
});

test("picker: fuzzy picks like fzf, and meaning search ranks the piped lines", { skip: !usableFzf }, async (t) => {
  const s = await standIn(t);
  const input = "bump deps\nadd backoff on 529s\nretry failed uploads\nfix typo\n";
  const fuzzy = await picker(t, { input, steps: [["wait", "fuzzy>"], ["send", "typo"], ["wait", "2/4"], ["send", ENTER]] });
  assert.equal(fuzzy.code, 0, fuzzy.stderr);
  assert.equal(fuzzy.output, "fix typo\n");
  const env = { TYPESAFE_API_KEY: "fixture-only", JEVZF_JEV_ENDPOINT: s.endpoint };
  const home = scratch(t);
  const meaning = await picker(t, { input, env, home, steps: [["wait", "fuzzy>"], ["send", `${ESC}m`], ["wait", "Type what you mean"], ["send", "when uploads fail (again)"], ["wait", "(again)"], ["send", ENTER], ["wait", "found in 4 lines"], ["send", ENTER]] });
  assert.equal(meaning.code, 0, meaning.stderr);
  assert.equal(meaning.output, "retry failed uploads\n");
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].state.search, "when uploads fail (again)");
  // The same words again over the same lines are answered from the cache
  const again = await picker(t, { input, env, home, steps: [["wait", "fuzzy>"], ["send", `${ESC}m`], ["wait", "Type what you mean"], ["send", "when uploads fail (again)"], ["wait", "(again)"], ["send", ENTER], ["wait", "all from the cache"], ["send", "\x1b[B"], ["send", ENTER]] });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.output, "add backoff on 529s\n");
  assert.equal(s.requests.length, 1);
});

test("picker: without a key meaning mode explains itself and escape exits 130", { skip: !usableFzf }, async (t) => {
  const result = await picker(t, { input: "retry\n", env: { TYPESAFE_API_KEY: "" }, steps: [["wait", "fuzzy>"], ["send", `${ESC}m`], ["wait", "export TYPESAFE_API_KEY"], ["send", `retry${ENTER}`], ["wait", "retry"], ["send", ESC]] });
  assert.equal(result.code, 130, result.stderr);
  assert.equal(result.output, "");
});

test("picker: leaving meaning mode mid-search stops it and closes its spend hold", { skip: !usableFzf }, async (t) => {
  const s = await standIn(t, { hold: true });
  const home = scratch(t);
  const env = { TYPESAFE_API_KEY: "fixture-only", JEVZF_JEV_ENDPOINT: s.endpoint };
  const result = await picker(t, { input: "retry\nbump\n", env, home, steps: [["wait", "fuzzy>"], ["send", `${ESC}m`], ["wait", "Type what you mean"], ["send", `why${ENTER}`], ["wait", "Searching for"], ["sleep", "1"], ["send", `${ESC}f`], ["wait", "alt-m searches by meaning"], ["send", ESC]] });
  assert.equal(result.code, 130, result.stderr);
  assert.equal(s.requests.length, 1);
  const spend = path.join(home, "jevzf", "spend");
  let last;
  for (let i = 0; i < 100 && !last?.closed; i++) {
    await sleep(50);
    const [file] = existsSync(spend) ? readdirSync(spend) : [];
    if (file) last = readFileSync(path.join(spend, file), "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  }
  // Closed at what the abandoned attempt may have cost, not left holding the whole ceiling
  assert.equal(last?.closed, true);
  assert.equal(last.hold, last.usd);
  assert.ok(last.usd < 0.02);
});

test("picker: meaning search sees input that arrived after leaving fuzzy mode", { skip: !usableFzf }, async (t) => {
  const s = await standIn(t);
  const env = { TYPESAFE_API_KEY: "fixture-only", JEVZF_JEV_ENDPOINT: s.endpoint };
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}\n`);
  const input = [[0, "bump deps\n"], [2, lines.slice(0, 10).join("")], [0.3, lines.slice(10, 20).join("")], [0.3, `${lines.slice(20).join("")}retry failed uploads\n`]];
  const result = await picker(t, { input, env, steps: [["wait", "fuzzy>"], ["send", `${ESC}m`], ["wait", "Type what you mean"], ["sleep", "4"], ["send", `why${ENTER}`], ["wait", "found in 42 lines"], ["send", ENTER]] });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output, "retry failed uploads\n");
});

test("picker: a line split across chunks is never listed or searched until it is whole", { skip: !usableFzf }, async (t) => {
  const s = await standIn(t);
  const env = { TYPESAFE_API_KEY: "fixture-only", JEVZF_JEV_ENDPOINT: s.endpoint };
  const input = [[0, "bump deps\nadd backoff\nretry fai"], ["rest", "led uploads\nfix typo\n"]];
  const early = await picker(t, { input, env, steps: [["wait", "fuzzy>"], ["send", `${ESC}m`], ["wait", "2 lines so far"], ["send", "why"], ["wait", "why"], ["send", ENTER], ["wait", "in the first 2 lines so far"], ["touch", "rest"], ["send", ESC]] });
  assert.equal(early.code, 130, early.stderr);
  assert.deepEqual(Object.values(s.requests[0].state.items).sort(), ["add backoff", "bump deps"]);
  // The header catches up when the rest arrives, and leaving meaning follows the copy, so the line
  // appears whole
  const later = await picker(t, { input, env, steps: [["wait", "fuzzy>"], ["send", `${ESC}m`], ["wait", "2 lines so far"], ["touch", "rest"], ["wait", "enter · 4 lines\r"], ["send", `${ESC}f`], ["wait", "fuzzy>"], ["send", "uploads"], ["wait", "1/4"], ["send", ENTER]] });
  assert.equal(later.code, 0, later.stderr);
  assert.equal(later.output, "retry failed uploads\n");
});

test("meaning mode refuses input over 10 MiB without reading it", async (t) => {
  const f = keyFixture(t, { TYPESAFE_API_KEY: "fixture-only" });
  truncateSync(inputFile(f.dir), 10 * 1024 * 1024 + 1);
  assert.match(await f.key("meaning"), /input exceeds 10 MiB; narrow the input first/);
});

test("input that passes 10 MiB after enter ends the search with a failure, not a stuck search", async (t) => {
  const f = keyFixture(t, { TYPESAFE_API_KEY: "fixture-only" });
  await f.key("meaning");
  await f.key("enter", "why uploads fail");
  truncateSync(inputFile(f.dir), 10 * 1024 * 1024 + 1);
  const home = path.join(f.dir, "home");
  // A pipe the worker reads as stdin, held open as fzf holds it, so the search is not superseded
  const worker = spawn(process.execPath, [fileURLToPath(new URL("../lib/picker/child.mjs", import.meta.url)), "work", String(loadState(f.dir).gen)], { env: { ...utf8, PATH: process.env.PATH, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home, TYPESAFE_API_KEY: "fixture-only", JEVZF_PICKER_DIR: f.dir }, stdio: ["pipe", "ignore", "ignore"] });
  const code = await new Promise((resolve) => worker.on("close", resolve));
  assert.equal(code, 0);
  const state = loadState(f.dir);
  assert.equal(state.phase, "results");
  assert.equal(state.summary, "Meaning search failed: input exceeds 10 MiB; narrow the input first");
});

test("picker: --read0 keeps multiline records whole through a meaning search", { skip: !usableFzf }, async (t) => {
  const s = await standIn(t);
  const env = { TYPESAFE_API_KEY: "fixture-only", JEVZF_JEV_ENDPOINT: s.endpoint };
  const result = await picker(t, { input: "bump\ndeps\0retry\nuploads\0", args: ["--read0"], env, steps: [["wait", "fuzzy>"], ["send", `${ESC}m`], ["wait", "Type what you mean"], ["send", `why${ENTER}`], ["wait", "found in 2 lines"], ["send", ENTER]] });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output, "retry\nuploads\0");
});

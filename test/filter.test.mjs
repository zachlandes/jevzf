import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_MODEL } from "../lib/meaning/jev.mjs";

const cli = fileURLToPath(new URL("../bin/jevzf.mjs", import.meta.url));
async function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-filter-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: PINNED_MODEL, answers: Object.fromEntries(Object.entries(request.state.items).map(([id, text]) => [id, { type: "noul", noul: text.includes("login") ? 0.95 : text.includes("reset") ? 0.8 : 0.1 }])), usage: { input_tokens: 100 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const env = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, TYPESAFE_API_KEY: "fixture-only", JEVZF_JEV_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/systemone` };
  const run = (input, args = ["authentication"], overrides = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...overrides } });
    const stdout = [], stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
  return { run, requests };
}

test("filter accepts a first-run environment key and preserves ANSI while scoring plain text", async (t) => {
  const f = await fixture(t);
  const result = await f.run("reset\n\x1b[31mlogin\x1b[0m\ngarden\n", ["--scores", "signing", "in"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString(), "0.95\t\x1b[31mlogin\x1b[0m\n0.80\treset\n");
  assert.equal(f.requests[0].state.search, "signing in");
  assert.ok(!JSON.stringify(f.requests).includes("\\u001b"));
});

test("missing-key filter fails while estimate sends nothing and needs no key", async (t) => {
  const f = await fixture(t);
  const noKey = { TYPESAFE_API_KEY: "" };
  const result = await f.run("login\n", ["query"], noKey);
  assert.equal(result.code, 2);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr, /TYPESAFE_API_KEY/);
  const estimate = await f.run("login\n", ["--estimate", "query"], noKey);
  assert.equal(estimate.code, 0);
  assert.match(estimate.stdout.toString(), /1 lines · about USD/);
  assert.equal(f.requests.length, 0);
});

test("read0 keeps embedded newlines and emits NUL records", async (t) => {
  const f = await fixture(t);
  const result = await f.run("reset\npassword\0login\0garden\0", ["--read0", "query"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString(), "login\0reset\npassword\0");
});

test("ranking a final unterminated input record keeps output records distinct", async (t) => {
  const f = await fixture(t);
  const result = await f.run("reset\nlogin");
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString(), "login\nreset\n");
});

test("floor, closest, no-cache and invalid options have executable CLI contracts", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run("garden\n")).code, 1);
  const closest = await f.run("garden\n", ["--closest", "1", "authentication"]);
  assert.equal(closest.stdout.toString(), "garden\n");
  assert.equal(f.requests.length, 1);
  await f.run("garden\n", ["--no-cache", "--floor", "0", "authentication"]);
  assert.equal(f.requests.length, 2);
  assert.equal((await f.run("login\n", ["--floor", "1.5", "query"])).code, 2);
  assert.equal(f.requests.length, 2);
});

test("a redacted authorization header is sent as a placeholder instead of refusing the search", async (t) => {
  const f = await fixture(t);
  const result = await f.run("curl -H 'Authorization: Bearer abcdefghijklmnop'\nlogin\n");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.toString(), "login\n");
  const sent = JSON.stringify(f.requests);
  assert.ok(sent.includes("Authorization: [redacted]"));
  assert.ok(!sent.includes("abcdefghijklmnop"));
});

test("missing-key guidance names the variable and a quoted estimate command", async (t) => {
  const f = await fixture(t);
  const result = await f.run("login\n", ["it's", "retry"], { TYPESAFE_API_KEY: "" });
  assert.equal(result.code, 2);
  assert.equal(result.stderr, "jevzf: meaning search needs a TypeSafe API key; nothing was sent.\n  export TYPESAFE_API_KEY=...   (get one at console.typesafe.ai/settings/keys)\n  To see what this search would cost first: jevzf --estimate 'it'\\''s retry'\n");
  assert.equal(f.requests.length, 0);
});

function interruptAfter(child, ms) {
  return new Promise((resolve) => {
    const start = Date.now();
    setTimeout(() => child.kill("SIGINT"), ms);
    child.on("close", (code) => resolve({ code, elapsed: Date.now() - start }));
  });
}

test("ctrl-c exits 130 while waiting on stdin and while a request is in flight", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-interrupt-"));
  let arrived;
  const request = new Promise((resolve) => { arrived = resolve; });
  // Never answers, so only the interrupt can end the search
  const server = createServer((req) => { req.resume(); arrived(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const env = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, TYPESAFE_API_KEY: "fixture-only", JEVZF_JEV_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/systemone` };
  // Signals the test through fd 3 once the CLI installs its handler, so SIGINT never races start-up
  const ready = `data:text/javascript,${encodeURIComponent('import { writeSync } from "node:fs"; process.on("newListener", (name) => { if (name === "SIGINT") writeSync(3, "ready"); });')}`;
  const idle = spawn(process.execPath, ["--import", ready, cli, "query"], { env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  await new Promise((resolve) => idle.stdio[3].once("data", resolve));
  const waiting = await interruptAfter(idle, 100);
  assert.equal(waiting.code, 130);
  assert.ok(waiting.elapsed < 2000);
  const busy = spawn(process.execPath, [cli, "query"], { env });
  busy.stdin.end("login\n");
  await request;
  const inFlight = await interruptAfter(busy, 0);
  assert.equal(inFlight.code, 130);
  assert.ok(inFlight.elapsed < 2000);
});

// Takes the picker's legibility screenshots on a Mac, for a person to run from their own terminal.
// It opens its own WezTerm and Terminal.app windows, shows the picker in each against a loopback
// stand-in for Jev (no key, no network, no spend), captures each window by id, closes every window
// it opened and writes the PNGs to one folder. It changes no terminal profile or config: WezTerm
// gets a throwaway config file, and a Terminal.app window only changes its own tab's settings.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { childCommand } from "../lib/picker/keys.mjs";
import { findFzf } from "../lib/picker/run.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(REPO, "bin", "jevzf.mjs");
const WORDS = "when did we change the retry logic";
const Y = "\x1b[33m", R = "\x1b[0m";
// Colored hashes as `git log --color` prints them, and long lines that fzf must cut
const INPUT = [
  "9f3c2a1 fix: back off harder on 529s from the model API",
  "4b7e0d2 feat: add dark mode toggle to settings",
  "c81a9e4 chore: bump eslint to 9.12",
  "7d20f5b fix: retry uploads that fail with a reset connection instead of surfacing the error to the user",
  "e5a1c37 docs: explain the release checklist",
  "2c9b8f0 refactor: split the billing module",
  "a04e6d9 feat: show last sync time in the footer",
  "f19d7c3 fix: timezone off by one on invoices",
  "3e8b2a5 test: cover empty cart checkout",
  "b6d4f10 perf: cache avatar thumbnails",
  "18ac9e7 fix: stop double-sending welcome emails",
  "d93f4b2 feat: export reports as CSV",
  "0c7e5a8 chore: rotate staging certificates",
  "61b2d9f fix: honour retry-after on rate-limited webhooks",
  "a8f0c36 refactor: rename config keys",
  "5d3e7b1 feat: keyboard shortcut for search",
  "e2c4a90 fix: crash when profile photo is missing",
  "97b1f6d docs: add screenshots to the README",
  "4f6a2c8 feat: bulk archive old projects",
  "b1e9d05 fix: flaky login test on CI"
].map((line) => `${Y}${line.slice(0, 7)}${R}${line.slice(7)}`).join("\n") + "\n";

const UTF8 = { LANG: "en_US.UTF-8" };
const MINIMAL = { LANG: null, LC_ALL: null, LC_CTYPE: null };
// Each case is one window; states are captured in order within it
const CASES = [
  { term: "wezterm", name: "dark-80x24", cols: 80, rows: 24, states: ["fuzzy", "ask", "running", "results"] },
  { term: "wezterm", name: "dark-80x24-nokey", cols: 80, rows: 24, key: false, states: ["ask"] },
  { term: "wezterm", name: "dark-60x24", cols: 60, rows: 24, states: ["ask", "results"] },
  { term: "wezterm", name: "dark-120x24", cols: 120, rows: 24, states: ["results"] },
  { term: "wezterm", name: "dark-200x24", cols: 200, rows: 24, states: ["results"] },
  { term: "wezterm", name: "dark-80x15-short", cols: 80, rows: 15, states: ["ask", "results"] },
  { term: "wezterm", name: "light-80x24", cols: 80, rows: 24, scheme: "Builtin Light", states: ["ask", "results"] },
  { term: "wezterm", name: "solarized-light-80x24", cols: 80, rows: 24, scheme: "Builtin Solarized Light", states: ["results"] },
  { term: "wezterm", name: "font-small-80x24", cols: 80, rows: 24, font: 10, states: ["results"] },
  { term: "wezterm", name: "font-large-80x24", cols: 80, rows: 24, font: 20, states: ["results"] },
  { term: "wezterm", name: "256-colour-80x24", cols: 80, rows: 24, env: { COLORTERM: null }, states: ["results"] },
  { term: "wezterm", name: "16-colour-80x24", cols: 80, rows: 24, env: { TERM: "xterm", COLORTERM: null }, states: ["results"] },
  { term: "wezterm", name: "no-color-80x24", cols: 80, rows: 24, env: { NO_COLOR: "1" }, states: ["ask", "results"] },
  { term: "wezterm", name: "minimal-locale-80x24", cols: 80, rows: 24, env: MINIMAL, states: ["ask", "results"] },
  { term: "terminal", name: "basic-80x24", cols: 80, rows: 24, profile: "Basic", states: ["fuzzy", "ask", "running", "results"] },
  { term: "terminal", name: "basic-80x24-nokey", cols: 80, rows: 24, profile: "Basic", key: false, states: ["ask"] },
  { term: "terminal", name: "pro-dark-80x24", cols: 80, rows: 24, profile: "Pro", states: ["ask", "results"] },
  { term: "terminal", name: "novel-light-80x24", cols: 80, rows: 24, profile: "Novel", states: ["results"] },
  { term: "terminal", name: "basic-60x24", cols: 60, rows: 24, profile: "Basic", states: ["ask", "results"] },
  { term: "terminal", name: "basic-120x24", cols: 120, rows: 24, profile: "Basic", states: ["results"] },
  { term: "terminal", name: "basic-200x24", cols: 200, rows: 24, profile: "Basic", states: ["results"] },
  { term: "terminal", name: "basic-80x15-short", cols: 80, rows: 15, profile: "Basic", states: ["ask", "results"] },
  { term: "terminal", name: "basic-16-colour-80x24", cols: 80, rows: 24, profile: "Basic", env: { TERM: "xterm", COLORTERM: null }, states: ["results"] },
  { term: "terminal", name: "no-color-80x24", cols: 80, rows: 24, profile: "Basic", env: { NO_COLOR: "1" }, states: ["results"] },
  { term: "terminal", name: "minimal-locale-80x24", cols: 80, rows: 24, profile: "Basic", env: MINIMAL, states: ["ask", "results"] }
];

// --check runs every case in a hidden tmux session and saves text captures instead, opening no
// windows, so the driving can be tested on a machine without Screen Recording permission
const CHECK = process.argv.includes("--check");
const say = (text) => process.stdout.write(`${text}\n`);
const osa = (script, lang = "AppleScript") => execFileSync("osascript", ["-l", lang, "-e", script], { encoding: "utf8" }).trim();

// Answers like Jev would for the sample lines, after a pause long enough to capture the search running
function standIn() {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const items = JSON.parse(body).state.items;
    await sleep(2000);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 2800 }, answers: Object.fromEntries(Object.entries(items).map(([id, text]) => [id, { type: "noul", noul: /retry|back off|529/.test(text) ? 0.93 : /timeout|rate-limited/.test(text) ? 0.7 : 0.04 }])) }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

export function windowOf(pids) {
  const found = osa(`ObjC.import("CoreGraphics");
    const pids = ${JSON.stringify(pids.map(Number))};
    const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0));
    let best = "", area = 0;
    for (let i = 0; i < list.count; i++) {
      const w = list.objectAtIndex(i);
      if (!pids.includes(w.objectForKey("kCGWindowOwnerPID").js) || w.objectForKey("kCGWindowLayer").js !== 0) continue;
      const b = w.objectForKey("kCGWindowBounds");
      const size = b.objectForKey("Width").js * b.objectForKey("Height").js;
      if (size > area) { area = size; best = String(w.objectForKey("kCGWindowNumber").js); }
    }
    best`, "JavaScript");
  return found || null;
}

const post = (sock, body) => new Promise((resolve) => {
  const req = request({ socketPath: sock, method: "POST", path: "/", timeout: 3000 }, (res) => { res.resume(); res.on("end", resolve); });
  req.on("error", resolve);
  req.on("timeout", () => { req.destroy(); resolve(); });
  req.end(body);
});

async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function main() {
  if (process.platform !== "darwin") throw new Error("this script takes macOS screenshots; run it on a Mac");
  findFzf(process.env);
  const haveWezterm = spawnSync("wezterm", ["--version"]).status === 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? path.join(os.homedir(), "Desktop", `jevzf-legibility-${stamp}`);
  mkdirSync(out, { recursive: true });
  // Short paths, since the picker's socket path must stay under macOS's 104-byte limit
  const work = mkdtempSync("/tmp/jzshots.");
  writeFileSync(path.join(work, "input"), INPUT);
  const server = await standIn();
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/systemone`;
  // Not opening Terminal.app at all in a check, so it cannot be left running either
  const terminalWasRunning = CHECK || spawnSync("pgrep", ["-x", "Terminal"]).status === 0;
  const open = new Set();
  const closeAll = () => {
    for (const close of open) { try { close(); } catch { /* already gone */ } }
    open.clear();
  };
  const interrupted = () => { closeAll(); server.closeAllConnections(); server.close(); rmSync(work, { recursive: true, force: true }); process.exit(130); };
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  const written = [], skipped = [];
  try {
    for (const [index, spec] of CASES.entries()) {
      const label = `${spec.term}-${spec.name}`;
      if (spec.term === "wezterm" && !haveWezterm && !CHECK) { skipped.push(`${label} (wezterm not found)`); continue; }
      process.stdout.write(`${String(index + 1).padStart(2)}/${CASES.length} ${label} `);
      const dir = path.join(work, String(index));
      mkdirSync(dir);
      const home = path.join(dir, "h");
      const env = {
        ...UTF8, TERM: "xterm-256color", COLORTERM: "truecolor", FZF_DEFAULT_OPTS: "", NO_COLOR: null,
        HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home, TMPDIR: dir,
        TYPESAFE_API_KEY: spec.key === false ? null : "stand-in-no-real-key", JEVZF_JEV_ENDPOINT: endpoint,
        PATH: process.env.PATH, JEVZF_FZF: process.env.JEVZF_FZF ?? null,
        ...spec.env
      };
      const lines = Object.entries(env).map(([name, value]) => value === null ? `unset ${name}` : `export ${name}='${String(value).replaceAll("'", "'\\''")}'`);
      writeFileSync(path.join(dir, "run.sh"), `${lines.join("\n")}\nprintf '\\033[3J\\033[H\\033[2J'\n'${process.execPath}' '${CLI}' < '${path.join(work, "input")}' > /dev/null\n`);
      let windowId, close;
      const tmux = (...args) => execFileSync("tmux", ["-L", `jzshots-${process.pid}`, ...args], { encoding: "utf8" });
      if (CHECK) {
        tmux("new-session", "-d", "-x", String(spec.cols), "-y", String(spec.rows), "-s", String(index), `sh '${path.join(dir, "run.sh")}'`);
        close = () => spawnSync("tmux", ["-L", `jzshots-${process.pid}`, "kill-session", "-t", String(index)]);
        open.add(close);
      } else if (spec.term === "wezterm") {
        writeFileSync(path.join(dir, "wezterm.lua"), [
          "return {",
          `  initial_cols = ${spec.cols}, initial_rows = ${spec.rows}, font_size = ${spec.font ?? 13},`,
          spec.scheme ? `  color_scheme = ${JSON.stringify(spec.scheme)},` : "",
          "  check_for_updates = false, automatically_reload_config = false, enable_tab_bar = false,",
          "  window_close_confirmation = 'NeverPrompt', audible_bell = 'Disabled',",
          `  term = ${JSON.stringify(env.TERM)},`,
          "}"
        ].join("\n"));
        const klass = `jevzf-shots-${index}-${process.pid}`;
        const gui = spawn("wezterm", ["--config-file", path.join(dir, "wezterm.lua"), "start", "--always-new-process", "--class", klass, "--", "sh", path.join(dir, "run.sh")], { detached: true, stdio: "ignore" });
        gui.unref();
        const pids = () => spawnSync("pgrep", ["-f", klass], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
        close = () => { for (const pid of pids()) { try { process.kill(Number(pid)); } catch { /* exited */ } } };
        open.add(close);
        windowId = await until(() => { const p = pids(); return p.length && windowOf(p); }, "the WezTerm window");
      } else {
        const id = osa(`tell application "Terminal"
          set t to do script "exec sh '${path.join(dir, "run.sh")}'"
          try
            set current settings of t to settings set ${JSON.stringify(spec.profile)}
          end try
          set number of columns of t to ${spec.cols}
          set number of rows of t to ${spec.rows}
          return id of (first window whose tabs contains t)
        end tell`);
        close = () => osa(`tell application "Terminal" to close (every window whose id is ${id})`);
        open.add(close);
        windowId = id;
      }
      const sock = await until(() => {
        const run = existsSync(dir) && readdirSync(dir).find((name) => name.startsWith("jz."));
        return run && existsSync(path.join(dir, run, "fzf.sock")) && path.join(dir, run);
      }, "the picker");
      const state = () => { try { return JSON.parse(readFileSync(path.join(sock, "state.json"), "utf8")); } catch { return {}; } };
      const socket = path.join(sock, "fzf.sock");
      await sleep(800);
      for (const name of spec.states) {
        if (name === "fuzzy") await post(socket, "change-query(fix retry)");
        // Each state starts from whichever earlier state it needs
        if (["ask", "running", "results"].includes(name) && state().mode !== "meaning") {
          await post(socket, `change-query(${WORDS})+transform(${childCommand("key meaning")})`);
          await until(() => state().mode === "meaning", "meaning mode");
        }
        if (["running", "results"].includes(name) && state().phase === "ask") {
          await post(socket, `transform(${childCommand("key enter")})`);
          await until(() => state().phase !== "ask", "the search to start");
        }
        if (name === "results") await until(() => state().phase === "results", "the results");
        await sleep(900);
        const file = path.join(out, `${label}-${name}.png`);
        if (CHECK) writeFileSync(file.replace(/\.png$/, ".txt"), tmux("capture-pane", "-p", "-t", String(index)));
        else execFileSync("screencapture", ["-x", "-o", "-l", windowId, file]);
        written.push(file);
        process.stdout.write(`${name} `);
      }
      await post(socket, "abort");
      await sleep(300);
      close();
      open.delete(close);
      say("");
    }
  } finally {
    closeAll();
    server.closeAllConnections();
    server.close();
    rmSync(work, { recursive: true, force: true });
    if (CHECK) {
      spawnSync("tmux", ["-L", `jzshots-${process.pid}`, "kill-server"]);
      rmSync(path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid()}`, `jzshots-${process.pid}`), { force: true });
    }
    // Terminal.app opens its own default window when a script starts it
    if (!terminalWasRunning && spawnSync("pgrep", ["-x", "Terminal"]).status === 0) osa('tell application "Terminal" to quit');
  }
  writeFileSync(path.join(out, "cases.json"), JSON.stringify(CASES, null, 2));
  say(`\n${written.length} ${CHECK ? "text captures" : "screenshots"}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}`);
  say(out);
}

main().catch((error) => {
  process.stderr.write(`legibility-shots: ${error.message}\n`);
  if (/could not create image/.test(error.message)) process.stderr.write("Allow Screen Recording for the terminal running this script (System Settings > Privacy & Security), then run it again.\n");
  process.exitCode = 1;
});

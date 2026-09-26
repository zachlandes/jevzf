import { request } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, openSync, readSync, writeSync, closeSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { openJev, searchByMeaning, describeError } from "../core.mjs";
import { handleKey, loadState, saveState, readInput, endFile, usableLength, inputFile, resultsFile, headerAction, queuedFile, childCommand } from "./keys.mjs";
import { act, glyphs, summary } from "./view.mjs";
import { shellQuote } from "../format.mjs";

// Runs inside fzf: `key <name>` answers a binding with actions on stdout, `list` is the reload
// command for the whole input, and `search <gen>` is the reload command for one meaning search,
// streaming matches and pushing progress over fzf's socket

function post(env, body) {
  return new Promise((resolve) => {
    if (!env.FZF_SOCK) return resolve();
    const req = request({ socketPath: env.FZF_SOCK, method: "POST", path: "/", timeout: 2000 }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", resolve);
    req.on("timeout", () => { req.destroy(); resolve(); });
    req.end(body);
  });
}

// fzf ends a superseded reload with SIGKILL, which would leave the run's spend hold open, so the
// reload command only forwards output from a search in its own process group. The search reads
// the forwarder's pipe as its stdin and stops cleanly when that closes
function forward(gen) {
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), "work", String(gen)], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
  worker.stdout.pipe(process.stdout);
  process.stdout.on("error", () => {});
  return new Promise((resolve) => worker.on("close", resolve));
}

// Lists the copy as it grows, a whole record at a time, until stdin has ended. Meaning's header
// counts and prices the copy, so it is redrawn at most once a second while records arrive and once
// more at the end
async function list(dir, env) {
  const delimiter = loadState(dir).options.read0 ? 0 : 10;
  process.stdout.on("error", () => process.exit(0));
  const fd = openSync(inputFile(dir), "r");
  const chunk = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0);
  let grown = false;
  let lastRedraw = 0;
  const emit = async (bytes, whole) => {
    const usable = usableLength(bytes, delimiter, whole);
    if (usable) await new Promise((resolve) => process.stdout.write(bytes.subarray(0, usable), resolve));
    pending = bytes.subarray(usable);
    grown ||= usable > 0;
  };
  const redraw = async (force) => {
    if (!force && (!grown || performance.now() - lastRedraw < 1000)) return;
    grown = false;
    lastRedraw = performance.now();
    const state = loadState(dir);
    if (state?.mode === "meaning" && state.phase === "ask") await post(env, act("transform", childCommand("key redraw")));
  };
  for (;;) {
    const whole = existsSync(endFile(dir));
    for (let read; (read = readSync(fd, chunk)) > 0;) await emit(Buffer.concat([pending, chunk.subarray(0, read)]), false);
    if (whole) {
      await emit(pending, true);
      return redraw(true);
    }
    await redraw(false);
    await sleep(100);
  }
}

async function search(dir, gen, env) {
  let state = loadState(dir);
  if (state?.gen !== gen) return;
  const controller = new AbortController();
  process.stdin.on("close", () => controller.abort(new Error("superseded")));
  process.stdin.resume();
  process.stdout.on("error", () => {});
  const current = () => loadState(dir)?.gen === gen;
  const update = async (changes, reload) => {
    if (!current()) return;
    state = { ...loadState(dir), ...changes };
    saveState(dir, state);
    const headerChange = await headerAction(dir, state, env, "");
    if (!reload) return post(env, headerChange);
    writeFileSync(queuedFile(dir), headerChange, { mode: 0o600 });
    await post(env, reload);
  };
  const delimiter = state.options.read0 ? 0 : 10;
  const shown = new Set();
  let lastProgress = 0;
  const started = performance.now();
  try {
    const { records, whole } = readInput(dir, state);
    const jev = openJev({ env });
    const result = await searchByMeaning({
      jev,
      query: state.words,
      items: records,
      floor: state.options.floor,
      closest: state.options.closest,
      capUsd: state.options.capUsd,
      noCache: state.options.noCache,
      signal: controller.signal,
      onFound: ({ index, item }) => {
        if (shown.has(index)) return;
        shown.add(index);
        process.stdout.write(Buffer.concat([item.bytes, Buffer.from([delimiter])]));
      },
      onProgress: (progress) => {
        if (performance.now() - lastProgress < 200) return;
        lastProgress = performance.now();
        update({ progress: { judged: progress.judged, total: progress.total, spend: progress.spend } }).catch(() => {});
      }
    });
    const fd = openSync(resultsFile(dir, gen), "wx", 0o600);
    try { for (const match of result.matches) writeSync(fd, Buffer.concat([match.item.bytes, Buffer.from([delimiter])])); }
    finally { closeSync(fd); }
    const lines = records.filter((record) => record.text.trim()).length;
    const text = summary({ ...result, lines, partial: !whole, seconds: (performance.now() - started) / 1000 }, state.words, glyphs(env));
    // The reload replaces the streamed matches with the ranked list and ends this process, so it
    // has to be the last thing sent
    await update({ phase: "results", summary: text, progress: null }, act("reload", `cat ${shellQuote(resultsFile(dir, gen))}`));
  } catch (error) {
    if (controller.signal.aborted) return;
    await update({ phase: "results", summary: `Meaning search failed: ${describeError(error)}`, progress: null });
  }
}

const [command, arg] = process.argv.slice(2);
const dir = process.env.JEVZF_PICKER_DIR;
if (!dir) process.exit(2);
if (command === "key") process.stdout.write(await handleKey(dir, arg));
else if (command === "list") await list(dir, process.env);
else if (command === "search") await forward(Number(arg));
else if (command === "work") {
  await search(dir, Number(arg), process.env);
  // A finished search must not wait on the forwarder's pipe
  process.exit(0);
}

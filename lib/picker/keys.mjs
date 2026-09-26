import { readFileSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openJev, estimateSearch, describeError, SearchError } from "../core.mjs";
import { shellQuote } from "../format.mjs";
import { splitRecords } from "../records.mjs";
import { EXACT_SHELL, MODES, PROMPTS, act, exactTerms, glyphs, header } from "./view.mjs";

// Each picker key runs `child.mjs key <name>`, which reads the picker's state, decides, and answers
// with fzf actions. Mode switches never touch the typed words, except when a meaning search runs:
// the box then empties so typing narrows the results, and the words wait in the header until
// another mode or a new search brings them back

const CHILD = fileURLToPath(new URL("./child.mjs", import.meta.url));
export const childCommand = (args) => `${shellQuote(process.execPath)} ${shellQuote(CHILD)} ${args}`;
export const inputFile = (dir) => path.join(dir, "input");
// The copy of stdin that every list and search reads; it is the whole input once the end file exists
export const endFile = (dir) => path.join(dir, "end");
export const resultsFile = (dir, gen) => path.join(dir, `results-${gen}`);
export const queuedFile = (dir) => path.join(dir, "queued");
// A search's latest progress or outcome, waiting for fzf to apply it while the search is current
export const pushFile = (dir, gen) => path.join(dir, `push-${gen}`);

// Actions that must wait for a list to land. fzf keeps the old list until a reload prints its first
// line, which for a search is a whole Jev round trip, so Enter empties the list and the load that
// follows starts the queued search; a finished search queues its summary the same way, so the
// header never announces results before they are the list. Plain shell, since it runs on every load
export const QUEUED_SHELL = `f="$JEVZF_PICKER_DIR/queued"; mv "$f" "$f.run" 2>/dev/null && cat "$f.run" && rm -f "$f.run"; true`;

// The picker keeps its own state and uses the core only through jevzf/core's public API. This is
// the core's documented input limit, checked here to refuse without reading the copy
const MAX_INPUT_BYTES = 10 * 1024 * 1024;

export function loadState(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Replaced atomically, since the search worker reads it while key handlers write it
export function saveState(dir, state) {
  const file = path.join(dir, "state.json");
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, file);
}

// Bytes a reader may use: all of a whole input, otherwise only up to the last delimiter, so a
// record still arriving is never listed, searched or picked
export const usableLength = (bytes, delimiter, whole) => (whole ? bytes.length : bytes.lastIndexOf(delimiter) + 1);

// The status is read before the copy, so bytes that arrive in between only count once it is whole
export function readInput(dir, state) {
  const whole = existsSync(endFile(dir));
  const delimiter = state.options.read0 ? 0 : 10;
  let input;
  try {
    // The copy has no size limit, since fzf lists all of it, so a large one is refused unread
    if (statSync(inputFile(dir)).size > MAX_INPUT_BYTES) throw new SearchError("input exceeds 10 MiB; narrow the input first");
    input = readFileSync(inputFile(dir));
  } catch (error) { if (error.code === "ENOENT") return { records: [], whole }; throw error; }
  return { records: splitRecords(input.subarray(0, usableLength(input, delimiter, whole)), delimiter), whole };
}

// The command gets its own part so a narrow header never splits it across lines
export const needsKey = (env) => `Meaning search needs a TypeSafe key ${glyphs(env).dot} export TYPESAFE_API_KEY`;

// What the header needs beyond the state: the cost of a search before it runs, or why it cannot
export async function headerInfo(dir, state, env, query) {
  const info = { summary: state.summary, progress: state.progress };
  if (state.mode !== "meaning" || state.phase !== "ask") return info;
  try {
    const jev = openJev({ env });
    const status = jev.status();
    if (!status.ok) return { problem: status.missing ? needsKey(env) : status.reason };
    const { records, whole } = readInput(dir, state);
    const estimate = estimateSearch({ jev, query: query.trim() || "?", items: records, capUsd: state.options.capUsd, noCache: state.options.noCache });
    return { estimate: { ...estimate, partial: !whole, remainingUsd: await jev.remaining() } };
  } catch (error) {
    return { problem: describeError(error) };
  }
}

export async function headerAction(dir, state, env, query) {
  return act("change-header", header({ state, env, info: await headerInfo(dir, state, env, query) }));
}

async function enterMode(dir, state, mode, words, env) {
  // Entering meaning reloads, since disabling search freezes whatever filtered list is showing and
  // a reload is the only way to show every line with search off. Leaving it reloads too, so the
  // list is the whole copy again and keeps following it as more input arrives
  const reload = state.mode === "meaning" || mode === "meaning";
  Object.assign(state, { mode, phase: "ask", gen: state.gen + 1, summary: null, progress: null });
  saveState(dir, state);
  rmSync(queuedFile(dir), { force: true });
  const actions = [act("change-prompt", PROMPTS[mode])];
  // fzf applies the search setting when the reloaded list arrives, so the setting goes first
  // An earlier search(...) outlives disable-search, so it is cleared explicitly
  if (mode === "meaning") actions.push("unbind(change)", act("search", ""), "disable-search");
  else if (mode === "exact") actions.push("enable-search", "rebind(change)");
  else actions.push("enable-search", "unbind(change)");
  if (reload) actions.push(act("reload", childCommand("list")));
  actions.push(act("change-query", words));
  if (mode === "exact") actions.push(act("search", exactTerms(words)));
  if (mode === "fuzzy") actions.push(act("search", words));
  actions.push(await headerAction(dir, state, env, words));
  return actions.join("+");
}

export async function handleKey(dir, key, env = process.env) {
  const state = loadState(dir);
  if (!state) return "ignore";
  const query = env.FZF_QUERY ?? "";
  const showingResults = state.mode === "meaning" && state.phase !== "ask";
  const words = showingResults ? state.words : query;

  if (key === "redraw") return headerAction(dir, state, env, query);
  // The search worker names a push by its generation, and fzf runs this in its own event loop, so
  // a search superseded by a key before fzf gets to the push can no longer touch the state, header
  // or list
  if (key === "pushed") {
    const push = pushFile(dir, state.gen);
    const taken = `${push}.run`;
    try { renameSync(push, taken); }
    catch (error) { if (error.code === "ENOENT") return "ignore"; throw error; }
    Object.assign(state, JSON.parse(readFileSync(taken, "utf8")));
    rmSync(taken);
    saveState(dir, state);
    const headerChange = await headerAction(dir, state, env, "");
    if (state.phase !== "results" || !existsSync(resultsFile(dir, state.gen))) return headerChange;
    writeFileSync(queuedFile(dir), headerChange, { mode: 0o600 });
    return act("reload", `cat ${shellQuote(resultsFile(dir, state.gen))}`);
  }
  if (key === "cycle") return enterMode(dir, state, MODES[(MODES.indexOf(state.mode) + 1) % MODES.length], words, env);
  if (key === "fuzzy" || key === "exact") return state.mode === key ? "ignore" : enterMode(dir, state, key, words, env);
  if (key === "meaning") return state.mode === "meaning" && !showingResults ? "ignore" : enterMode(dir, state, "meaning", words, env);

  if (key === "enter") {
    // A second press before the first match arrives would quit with nothing picked
    if (state.mode === "meaning" && state.phase === "running" && env.FZF_MATCH_COUNT === "0") return "ignore";
    if (state.mode !== "meaning" || state.phase !== "ask") return "accept";
    const typed = query.trim();
    if (!typed) return "ignore";
    const info = await headerInfo(dir, state, env, query);
    // Enter never sends when the header says a search cannot run
    if (info.problem) return act("change-header", header({ state, env, info }));
    Object.assign(state, { phase: "running", words: typed, gen: state.gen + 1, summary: null, progress: null });
    saveState(dir, state);
    writeFileSync(queuedFile(dir), act("reload", childCommand(`search ${state.gen}`)), { mode: 0o600 });
    return [
      act("change-prompt", PROMPTS.results),
      act("change-header", header({ state, env })),
      act("change-query", ""),
      "enable-search",
      act("reload", "true")
    ].join("+");
  }
  return "ignore";
}

export function fzfArgs(dir, options) {
  const key = (name) => `transform:${childCommand(`key ${name}`)}`;
  const g = glyphs(process.env);
  return [
    "--ansi",
    "--layout", "reverse",
    "--header-first",
    "--info", "inline-right",
    "--with-shell", "sh -c",
    // A Unix socket inside the private run directory, never a TCP port any local user could reach
    `--listen=${path.join(dir, "fzf.sock")}`,
    "--prompt", PROMPTS.fuzzy,
    "--header", `jevzf ${g.dot} ctrl-s switches mode`,
    "--bind", `start:unbind(change)+${act("reload", childCommand("list"))}+${key("redraw")}`,
    "--bind", `resize:${key("redraw")}`,
    "--bind", `ctrl-s:${key("cycle")}`,
    "--bind", `alt-f:${key("fuzzy")}`,
    "--bind", `alt-e:${key("exact")}`,
    "--bind", `alt-m:${key("meaning")}`,
    "--bind", `enter:${key("enter")}`,
    "--bind", `change:transform-search:${EXACT_SHELL}`,
    "--bind", `load:transform:${QUEUED_SHELL}`,
    // fzf draws box lines and a braille spinner whatever the locale
    ...(g.dot === "·" ? [] : ["--no-unicode"]),
    ...(options.read0 ? ["--read0", "--print0"] : [])
  ];
}

import { count, usd } from "../format.mjs";

// What the picker shows, as pure functions of its state, so each is testable without fzf

export const MODES = ["fuzzy", "exact", "meaning"];
export const PROMPTS = { fuzzy: "fuzzy> ", exact: "exact> ", meaning: "meaning> ", results: "filter> " };

// A terminal without a UTF-8 locale shows these as mojibake or nothing, so fall back to ASCII
export function glyphs(env) {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/i.test(locale)
    ? { dot: "·", open: "“", close: "”", ellipsis: "…" }
    : { dot: "|", open: "\"", close: "\"", ellipsis: "..." };
}

// fzf cuts header lines at its width instead of wrapping, so break between parts, then words.
// fzf indents the header by two columns
export function headerWidth(env) {
  const columns = Number(env.FZF_COLUMNS);
  return Math.max(20, (Number.isInteger(columns) && columns > 0 ? columns : 80) - 2);
}

export function fitWidth(line, width, dot) {
  const lines = [];
  let current = "";
  const push = () => { if (current) lines.push(current); current = ""; };
  const separator = ` ${dot} `;
  for (const part of line.split(separator)) {
    if (current && current.length + separator.length + part.length <= width) { current += `${separator}${part}`; continue; }
    push();
    for (const word of part.split(" ")) {
      if (current && current.length + 1 + word.length <= width) { current += ` ${word}`; continue; }
      push();
      current = word;
      while (current.length > width) { lines.push(current.slice(0, width)); current = current.slice(width); }
    }
  }
  push();
  return lines;
}

const QUOTED = 40;
export const quoted = (words, g) => `${g.open}${words.length > QUOTED ? `${words.slice(0, QUOTED - 1)}${g.ellipsis}` : words}${g.close}`;

// Reverse video without dim text: dim vanishes on some light themes, and NO_COLOR gets brackets
function modeLine(mode, env) {
  const plain = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  return MODES.map((name) => {
    if (name !== mode) return ` ${name} `;
    return plain ? `[${name}]` : `\x1b[1;7m ${name} \x1b[0m`;
  }).join(" ");
}

// Lines under the mode line, by phase; each string may hold several parts joined by the dot
export function statusLines({ state, env, info }) {
  const g = glyphs(env);
  const d = ` ${g.dot} `;
  if (state.mode !== "meaning") return [`enter picks${d}alt-m searches by meaning`];
  if (state.phase === "running") {
    const progress = info.progress ? `${d}${count(info.progress.judged)} of ${count(info.progress.total)} lines${d}${usd(info.progress.spend)}` : "";
    return [`Searching for ${quoted(state.words, g)} by meaning${g.ellipsis}${progress}`];
  }
  if (state.phase === "results") return [info.summary ?? "", `type to narrow${d}alt-m new search${d}enter picks`];
  if (info.problem) return [info.problem];
  const cost = info.estimate;
  return [
    `Type what you mean, then press enter${d}${count(cost.lines)} lines${cost.partial ? " so far" : ""}`,
    `about ${usd(cost.estimatedUsd, 2)}${d}never more than ${usd(cost.perSearchUsd)} per search${d}${usd(cost.remainingUsd)} left today`
  ];
}

export function header({ state, env, info = {} }) {
  const g = glyphs(env);
  const width = headerWidth(env);
  const lines = [`${modeLine(state.mode, env)}   ctrl-s switch`];
  for (const line of statusLines({ state, env, info })) {
    // A summary that cannot fit whole breaks before its time and cost, not between them
    const [what, stats] = line.split("\t");
    if (stats === undefined) lines.push(...fitWidth(what, width, g.dot));
    else if (what.length + stats.length + 3 <= width) lines.push(`${what} ${g.dot} ${stats}`);
    else lines.push(...fitWidth(what, width, g.dot), ...fitWidth(stats, width, g.dot));
  }
  return lines.join("\n");
}

export function summary(result, words, g) {
  const d = ` ${g.dot} `;
  const parts = [];
  const where = result.partial ? `the first ${count(result.lines)} lines so far` : `${count(result.lines)} lines`;
  if (result.fallback) parts.push(`nothing clearly matched ${quoted(words, g)}${result.partial ? ` in ${where}` : ""}; the ${result.matches.length} closest are shown`);
  else parts.push(`${quoted(words, g)}: ${count(result.matches.length)} found in ${where}`);
  if (result.stopped) parts.push(`stopped at the spend ceiling; ${count(result.unjudged)} lines unjudged`);
  if (result.failed) parts.push(`${count(result.failed)} lines failed`);
  const stats = [`${result.seconds.toFixed(1)} s`, result.cached ? `${usd(result.spend)}, all from the cache` : usd(result.spend)];
  // A tab marks where the header may break the summary
  return `${parts.join(d)}\t${stats.join(d)}`;
}

// An fzf action whose argument sits in whichever bracket pair it does not contain; only a header
// may span lines
export function act(name, arg = "") {
  const text = name === "change-header" ? String(arg) : String(arg).replace(/[\r\n]+/g, " ");
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"], ["~", "~"], ["!", "!"]]) {
    if (!text.includes(close)) return `${name}${open}${text}${close}`;
  }
  return `${name}(${text.replace(/\)/g, "")})`;
}

// fzf's exact term for each word, leaving fzf's own operators alone
export function exactTerms(query) {
  return query.split(/\s+/).filter(Boolean).map((word) => (word === "|" || /^['^!]/.test(word) ? word : `'${word}`)).join(" ");
}

// The same conversion in the shell, since exact mode runs it on every keystroke and starting
// node for each key would be felt
export const EXACT_SHELL = `printf '%s' "$FZF_QUERY" | awk '{ out = ""; for (i = 1; i <= NF; i++) { w = $i; if (w != "|" && w !~ /^[\\047^!]/) w = "\\047" w; out = out (i > 1 ? " " : "") w } printf "%s", out }'`;

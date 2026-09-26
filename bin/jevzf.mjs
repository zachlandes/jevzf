#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { openJev, searchByMeaning, estimateSearch, describeError } from "../lib/core.mjs";
import { usd, count, shellQuote } from "../lib/format.mjs";
import { splitRecords } from "../lib/records.mjs";
import { runPicker, PickerError } from "../lib/picker/run.mjs";
import { MAX_INPUT_TOKENS, usdFor } from "../lib/meaning/jev.mjs";

class UsageError extends Error {}
const HELP = `Usage: cmd | jevzf [options]           pick in fzf, with a meaning mode
       cmd | jevzf [options] QUERY...  print matching lines, best first

Jev-powered search for fzf. Node.js 22+; the picker needs fzf 0.66+.
Unofficial; not affiliated with TypeSafe.

In the picker, ctrl-s cycles fuzzy, exact and meaning (alt-f, alt-e, alt-m
jump); in meaning, type what you mean and press enter.

  --scores         Prefix each match with probability and a tab (filter)
  --floor P        Minimum probability (default 0.58)
  --closest N      Show N closest if none pass (default 0; picker 3)
  --max-cost USD   Lower this search's ceiling
  --no-cache       Neither read nor write cached answers
  --read0          Read and write NUL-separated records
  --estimate       Estimate without a key or network (filter)
  --help           Show help
  --version        Show version
  -- QUERY         Query beginning with a dash

Meaning search needs only TYPESAFE_API_KEY.
Config: ~/.config/jevzf/config.json (or $XDG_CONFIG_HOME/jevzf/config.json).
Limits: JEVZF_RPM, JEVZF_TPS; spend: JEVZF_PER_SEARCH_USD, JEVZF_PER_DAY_USD.
Built-in known secret formats are always filtered; a never-send file is optional.
`;

process.stdout.on("error", (error) => process.exit(error.code === "EPIPE" ? 0 : 2));
const notice = (message) => process.stderr.write(`jevzf: ${message}\n`);
const controller = new AbortController();
// fzf ends a superseded reload with SIGTERM and a closed terminal sends SIGHUP; like Ctrl-C, both
// abort in-flight requests so the run can close its spend hold before exiting
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
let interruptedBy;
// Only the filter handles these; the picker forwards them to fzf, which owns the terminal
const interruptible = () => {
  for (const signal of Object.keys(SIGNAL_EXIT)) {
    process.once(signal, () => {
      interruptedBy ??= signal;
      controller.abort(new Error("interrupted"));
      // Handling the signal replaces the default exit, so an idle stdin read must be ended explicitly
      process.stdin.destroy();
    });
  }
};
const lines = (value) => `${count(value)} ${value === 1 ? "line" : "lines"}`;

function parse(args) {
  const options = { floor: 0.58, closest: 0 };
  const query = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { query.push(...args.slice(i + 1)); break; }
    if (["--scores", "--read0", "--no-cache", "--estimate"].includes(arg)) { options[arg.slice(2)] = true; continue; }
    if (["--floor", "--closest", "--max-cost"].includes(arg)) {
      const value = args[++i];
      const n = value?.trim() ? Number(value) : NaN;
      if (!Number.isFinite(n) || n < 0 || (arg === "--floor" && n > 1) || (arg === "--closest" && !Number.isInteger(n))) throw new UsageError(`invalid ${arg}`);
      options[arg.slice(2)] = n;
      if (arg === "--closest") options.closestSet = true;
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError("unknown option; use -- before a query beginning with a dash");
    query.push(arg);
  }
  if (!query.join(" ").trim()) {
    if (options.scores || options.estimate) throw new UsageError("--scores and --estimate need a query; use --help");
    return { ...options, closest: options.closestSet ? options.closest : 3, query: null };
  }
  return { ...options, query: query.join(" ") };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(HELP); return; }
  if (args.length === 1 && args[0] === "--version") { process.stdout.write(`${JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version}\n`); return; }
  const opts = parse(args);
  if (process.stdin.isTTY) throw new UsageError("pipe text into jevzf");
  if (opts.query === null) {
    process.exitCode = await runPicker({ options: { floor: opts.floor, closest: opts.closest, capUsd: opts["max-cost"], noCache: !!opts["no-cache"], read0: !!opts.read0 } });
    return;
  }
  interruptible();
  const jev = openJev({ notice });
  const status = jev.status();
  if (!opts.estimate && status.missing) {
    throw new UsageError(`meaning search needs a TypeSafe API key; nothing was sent.
  export TYPESAFE_API_KEY=...   (get one at console.typesafe.ai/settings/keys)
  To see what this search would cost first: jevzf --estimate ${shellQuote(opts.query.replace(/[\x00-\x1f\x7f]/g, " "))}`);
  }
  if (!opts.estimate && !status.ok) throw new UsageError(status.reason);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    controller.signal.throwIfAborted();
    bytes += chunk.length;
    if (bytes > 10 * 1024 * 1024) throw new UsageError("input exceeds 10 MiB; narrow the input first");
    chunks.push(chunk);
  }
  controller.signal.throwIfAborted();
  const input = Buffer.concat(chunks);
  const delimiter = opts.read0 ? 0 : 10;
  if (!opts.read0 && input.includes(0)) throw new UsageError("NUL input needs --read0");
  const records = splitRecords(input, delimiter);
  const search = { jev, items: records, query: opts.query, capUsd: opts["max-cost"], noCache: opts["no-cache"] };
  const estimate = estimateSearch(search);
  if (opts.estimate) {
    process.stdout.write(`${lines(estimate.lines)} · ${count(estimate.cachedLines)} cached · about ${usd(estimate.estimatedUsd, 2)} · never more than ${usd(estimate.perSearchUsd)} per search · ${usd(estimate.perDayUsd)} per day · ${lines(estimate.changed)} changed by the never-send check\n`);
    return;
  }
  const remaining = await jev.remaining();
  if (process.stderr.isTTY) notice(`about ${usd(estimate.estimatedUsd, 2)} · never more than ${usd(estimate.perSearchUsd)} per search · ${usd(remaining)} left today`);
  // Every request first reserves its worst case, so the last one needs a full reservation of room.
  // Said whether or not stderr is a terminal, since it explains output that would otherwise look short
  if (estimate.cachedLines < estimate.lines && estimate.estimatedUsd + usdFor(MAX_INPUT_TOKENS) > Math.min(estimate.perSearchUsd, remaining)) notice(`this search may need more than ${remaining < estimate.perSearchUsd ? `the ${usd(remaining)} left today` : `its ${usd(estimate.perSearchUsd)} ceiling`}; lines past it go unjudged, in input order`);
  const start = performance.now();
  const result = await searchByMeaning({ ...search, floor: opts.floor, closest: opts.closest, signal: controller.signal });
  for (const [index, match] of result.matches.entries()) {
    if (opts.scores) process.stdout.write(`${match.p.toFixed(2)}\t`);
    process.stdout.write(match.item.bytes);
    // A moved unterminated record still needs a separator before the next record
    if (match.item.terminated || index < result.matches.length - 1) process.stdout.write(Buffer.from([delimiter]));
  }
  if (process.stderr.isTTY) notice(`${count(result.matches.length)} found in ${lines(estimate.lines)} · ${((performance.now() - start) / 1000).toFixed(1)} s · ${usd(result.spend)}`);
  if (!result.matches.length) process.exitCode = 1;
}

main().catch((error) => {
  if (controller.signal.aborted) { process.exitCode = SIGNAL_EXIT[interruptedBy]; return; }
  notice(error instanceof UsageError || error instanceof PickerError ? error.message : describeError(error));
  process.exitCode = 2;
});

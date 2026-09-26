#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { openJev, searchByMeaning, estimateSearch, describeError } from "../lib/core.mjs";
import { MAX_INPUT_TOKENS, usdFor } from "../lib/meaning/jev.mjs";

class UsageError extends Error {}
const HELP = `Usage: cmd | jevzf [options] QUERY...

Jev-powered meaning search for fzf. Node.js 22+.
Unofficial; not affiliated with TypeSafe.

  --scores         Prefix each match with probability and a tab
  --floor P        Minimum probability (default 0.58)
  --closest N      Show N closest if none pass (default 0)
  --max-cost USD   Lower this search's ceiling
  --no-cache       Neither read nor write cached answers
  --read0          Read and write NUL-separated records
  --estimate       Estimate without a key or network
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
for (const signal of Object.keys(SIGNAL_EXIT)) {
  process.once(signal, () => {
    interruptedBy ??= signal;
    controller.abort(new Error("interrupted"));
    // Handling the signal replaces the default exit, so an idle stdin read must be ended explicitly
    process.stdin.destroy();
  });
}
// Significant digits keep tiny amounts readable; cents stay visible on round amounts such as 0.20
const usd = (value, digits = 3) => {
  const text = new Intl.NumberFormat("en-US", { maximumSignificantDigits: digits }).format(value);
  return `USD ${(text.split(".")[1]?.length ?? 0) >= 2 ? text : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const count = (value) => value.toLocaleString("en-US");
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

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
      options[arg.slice(2)] = n; continue;
    }
    if (arg.startsWith("-")) throw new UsageError("unknown option; use -- before a query beginning with a dash");
    query.push(arg);
  }
  if (!query.join(" ").trim()) throw new UsageError("a meaning query is required; use --help");
  return { ...options, query: query.join(" ") };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(HELP); return; }
  if (args.length === 1 && args[0] === "--version") { process.stdout.write(`${JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version}\n`); return; }
  const opts = parse(args);
  if (process.stdin.isTTY) throw new UsageError("pipe text into jevzf");
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
  // Retain original bytes and terminators; scoring only receives decoded text
  const records = [];
  for (let start = 0; start < input.length;) {
    const end = input.indexOf(delimiter, start);
    const stop = end < 0 ? input.length : end;
    const bytes = input.subarray(start, stop);
    records.push({ text: bytes.toString("utf8"), bytes, terminated: end >= 0 });
    start = end < 0 ? input.length : end + 1;
  }
  const search = { jev, items: records, query: opts.query, capUsd: opts["max-cost"], noCache: opts["no-cache"] };
  const estimate = estimateSearch(search);
  if (opts.estimate) {
    process.stdout.write(`${count(estimate.lines)} lines · ${count(estimate.cachedLines)} cached · about ${usd(estimate.estimatedUsd, 2)} · never more than ${usd(estimate.perSearchUsd)} per search · ${usd(estimate.perDayUsd)} per day · ${count(estimate.changed)} lines changed by the never-send check\n`);
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
  if (process.stderr.isTTY) notice(`${count(result.matches.length)} found in ${count(estimate.lines)} lines · ${((performance.now() - start) / 1000).toFixed(1)} s · ${usd(result.spend)}`);
  if (!result.matches.length) process.exitCode = 1;
}

main().catch((error) => {
  if (controller.signal.aborted) { process.exitCode = SIGNAL_EXIT[interruptedBy]; return; }
  notice(error instanceof UsageError ? error.message : describeError(error));
  process.exitCode = 2;
});

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createSearch, describeError } from "../lib/core.mjs";

class UsageError extends Error {}

const HELP = `Usage: cmd | jevzf "<query>"

Print meaning-matched lines best-first. Requires Node.js 20+.
Without a configured key, input passes through unchanged and nothing is sent.

  --help       Show this help
  --version    Show the version
  -- QUERY     Search for a query beginning with a dash

Config: $XDG_CONFIG_HOME/jevzf/config.json (default ~/.config/jevzf/config.json)
JEVZF_CONFIG overrides the config path.
JEVZF_KEY_FILE and JEVZF_REDACTION_FILE select private files explicitly.

See README for setup, privacy, spend caps and stock fzf bindings.
`;

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  process.exit(2);
});
const notice = (message) => process.stderr.write(`jevzf: ${message}\n`);

async function main() {
  let args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(HELP); return; }
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version}\n`); return;
  }
  if (args[0] === "--") args = args.slice(1);
  else if (args[0]?.startsWith("-")) throw new UsageError("unknown option; use -- before a query beginning with a dash");
  if (args.length !== 1 || !args[0].trim()) throw new UsageError('usage: cmd | jevzf "<query>"');
  if (process.stdin.isTTY) throw new UsageError("pipe newline-delimited text into jevzf");
  const engine = createSearch({ notice });
  if (!engine.enabled) {
    for await (const chunk of process.stdin) {
      if (!process.stdout.write(chunk)) await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
    return;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 10 * 1024 * 1024) throw new UsageError("input exceeds 10 MiB; narrow the input first");
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString("utf8");
  if (input.includes("\0")) throw new UsageError("NUL-delimited or binary input is not supported; use newline-delimited text");
  const result = await engine.search({ query: args[0], lines: input.split(/\r?\n/) });
  if (result.lines.length) process.stdout.write(`${result.lines.join("\n")}\n`);
  else process.exitCode = 1;
}

main().catch((error) => {
  notice(error instanceof UsageError ? error.message : describeError(error));
  process.exitCode = 2;
});

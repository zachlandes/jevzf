# jevzf

Jev-powered search for fzf.
Unofficial; not affiliated with TypeSafe.

Pipe lines in, say what you mean, and get the matching lines back, best first, byte for byte as they came in.
[Jev](https://docs.typesafe.ai/) judges each line against your words, so "when did we change the retry logic" can find `a3f1c2e back off harder on 529s` without sharing a word with it.
It works on its own like `grep` or `fzf --filter`, and inside stock fzf through one binding.

## Try it

Requires Node.js 22 or newer.
jevzf is not on npm yet; to try this checkout:

```sh
npm pack
npm install -g ./jevzf-0.1.0.tgz
export TYPESAFE_API_KEY=...                        # console.typesafe.ai/settings/keys
git log --oneline | jevzf "when did we change the retry logic"
```

`TYPESAFE_API_KEY` is the only setup meaning search needs.
The built-in secret filter, spend ceilings, rate limiter and answer cache are on without any configuration.

Without a key, jevzf sends nothing and exits 2:

```text
jevzf: meaning search needs a TypeSafe API key; nothing was sent.
  export TYPESAFE_API_KEY=...   (get one at console.typesafe.ai/settings/keys)
  To see what this search would cost first: jevzf --estimate 'when did we change the retry logic'
```

`--estimate` needs no key and sends nothing:

```sh
git log --oneline | jevzf --estimate "when did we change the retry logic"
```

## With stock fzf

fzf reads its input once, so this binding works for any source you can run again, such as `git log`, `rg` or `FZF_DEFAULT_COMMAND`.
Ctrl-Space searches by meaning for what you have typed; Ctrl-F goes back to fzf's own fuzzy search.

```sh
SRC='git log --oneline'
eval "$SRC" | fzf \
    --bind "ctrl-space:reload($SRC | jevzf --closest 3 {q})+disable-search+change-prompt(meaning> )" \
    --bind "ctrl-f:reload($SRC)+enable-search+change-prompt(> )"
```

The search runs once per key press, never while you type, because every search is a paid request over the whole input.
Pressing Ctrl-Space again with the same words over the same lines is free: answers are cached per line.
The binding needs stock fzf with `disable-search`; there is no fork, patch or plugin.

## Options

```text
cmd | jevzf [options] QUERY...
```

- `--scores` prefixes each match with its probability and a tab, such as `0.83<TAB>`.
- `--floor P` sets the minimum probability for a match; the default is 0.58, the threshold Needle uses.
- `--closest N` prints the N best lines when none pass the floor; the default is 0.
- `--max-cost USD` lowers this search's ceiling; it never raises it.
- `--no-cache` neither reads nor writes cached answers.
- `--read0` reads and writes NUL-separated records, as `fzf --read0` and `xargs -0` do.
- `--estimate` counts lines, estimates the cost, names the ceilings and says how many lines the secret filter would change.
- `--help` and `--version` need no key.
- `--` ends the options, for a query that begins with a dash.

Exit codes follow grep and fzf: 0 at least one match, 1 nothing matched, 2 an error such as a bad flag, no key or every request failing, and 130 interrupted.
A search stopped by its ceiling still exits 0 or 1 by what it found, and says so on stderr.

Lines are judged in input order, so when a ceiling stops a search it is the last lines that go unjudged; pipe through `tac` to judge the newest first.
ANSI colour codes are removed from what is sent and kept in what is printed.
Blank lines are skipped, and identical lines share one judgment.
Ties keep input order.
Input is limited to 10 MiB, 5,000 distinct lines and 24,000 bytes per line, with a query of up to 400 characters.

## Cost and ceilings

When stderr is a terminal, jevzf prints a cost line before sending and a summary after:

```text
jevzf: about USD 0.012 · never more than USD 0.02 per search · USD 0.18 left today
jevzf: 14 found in 1,204 lines · 1.9 s · USD 0.0118
```

The first figure is an estimate and is never called a ceiling.
The ceilings are USD 0.02 per search and USD 0.20 per UTC day by default.
Every attempt, retries included, reserves the pinned model's full 65,536-token request limit against both ceilings before it is sent, and gives back the difference once the response reports its real usage.
At USD 0.042 per million input tokens, each reservation is about USD 0.0028, so a search never passes its ceiling even when a response goes missing.
An attempt that may have been billed without an answer stays booked at its reservation.
The model is pinned to `jev-1.13.0`; [its price and limits](https://docs.typesafe.ai/models.md) were checked on 2026-09-25.

The daily ceiling holds across processes: a search writes a hold for its ceiling before sending, so two searches at once cannot both spend the same allowance.
Spend is tracked per key and per tool, and a hold from a crashed process is released after ten minutes while anything it may have spent stays counted.
These are local ceilings, not account-wide billing controls.

## Rate limits

TypeSafe publishes 1,200 requests a minute and 250,000 tokens a second for `jev-1.13.0`.
jevzf keeps to 80% of both, counted across every process on the machine that uses the same key, so tools sharing a key stay under the limits together.
When TypeSafe answers 429 or 529, every process on that key pauses for the server's `retry-after`, and the official SDK retries the request.
One person's searches should never reach these limits; they matter when several tools share one key.

## Configuration

No configuration is needed.
To change the defaults, create `~/.config/jevzf/config.json` (or `$XDG_CONFIG_HOME/jevzf/config.json`) with any of these lines:

```json
{
  "key_file": "~/.config/jevzf/key",
  "never_send_file": "~/.config/jevzf/never-send.json",
  "spend": { "per_search_usd": 0.02, "per_day_usd": 0.2 },
  "limits": { "requests_per_minute": 1200, "tokens_per_second": 250000, "share": 0.8 }
}
```

`limits` describes your TypeSafe account, and `share` is the part of it jevzf may use.
For one-off runs and CI, `JEVZF_PER_SEARCH_USD`, `JEVZF_PER_DAY_USD`, `JEVZF_RPM` and `JEVZF_TPS` override the file, and `JEVZF_CONFIG` points at another file.
Relative paths in the file resolve beside it, and `~/` works.

The key comes from `TYPESAFE_API_KEY` first, then `key_file`, which must be mode 600; no other location is read.
Keep the key out of command arguments.

## Privacy

Meaning search sends the query and the lines to TypeSafe's HTTPS API.
Before anything is sent, a built-in filter replaces known secret formats: private keys, JWTs, bearer and authorization headers, `sk-` style API keys, GitHub, Slack, AWS and Google keys, `password=` style pairs and credentials in URLs.
It recognises known formats only; it does not guess at long random strings or email addresses.
The final check runs on the exact request body of every attempt, retries included, and refuses to send one in which a known secret survives.

For private values no pattern can know, such as names, customer ids or internal hosts, add a never-send list and point `never_send_file` or `JEVZF_NEVER_SEND_FILE` at it (mode 600):

```json
{
  "rules": [["person", "(?i)Example Person", "[person]"]],
  "forbidden": ["(?i)Example Person"]
}
```

`rules` holds `[class, pattern, replacement]` entries, and `forbidden` lists patterns that must never reach a request.
Patterns are JavaScript regular expressions that also accept a leading `(?i)`, `(?m)` or `(?s)` and `\1` or `\g<name>` replacements; backslashes need escaping in JSON.
No filter can promise to find every private detail, so choose what you pipe in.

The answer cache in `~/.cache/jevzf/answers` stores keyed hashes of lines and their probabilities for 30 days, never the query or the text, and stays under 50 MiB.
Spend and rate records in `~/.local/state/jevzf` hold times, amounts and a fingerprint of the key, never the key or any text.
Either directory can be deleted while no search is running; deleting `spend` also forgets today's spending.

## Library

The CLI is a thin layer over `jevzf/core`, which owns every call to Jev: the key, the secret filter, the ceilings, the rate limiter and the cache.
Other tools can use it; see [the core library](docs/core.md).
Its interface may change before 1.0.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm pack --dry-run
```

The one runtime dependency is TypeSafe's official SDK, `@typesafe-ai/sdk`, pinned to 0.6.0, which has no dependencies or install scripts of its own.
Tests use a loopback stand-in for TypeSafe and never a real key.
For tests only, `JEVZF_JEV_ENDPOINT` may point at an HTTP URL on `127.0.0.1` or `::1`; any other host is refused, and redirects are never followed.
CI runs on Node.js 22, 24 and 26.

## See also

[jgrep](https://github.com/keltokhy/jgrep) filters piped text by meaning with Jev, for anyone who wants a grep-focused tool.

## Licence and credits

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
jevzf is built for [fzf](https://github.com/junegunn/fzf) by Junegunn Choi.
Its meaning questions and 0.58 threshold come from Needle, by way of Dewey and herdr-find.

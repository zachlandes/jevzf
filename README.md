# jevzf

A meaning mode for fzf.
Unofficial; not affiliated with TypeSafe.

Pipe anything into `jevzf` and it opens stock fzf with a third mode beside fuzzy and exact: meaning.
In meaning mode you type what you mean and press Enter, and [Jev](https://docs.typesafe.ai/) judges every line against your words, so "when did we change the retry logic" can find `a3f1c2e back off harder on 529s` without sharing a word with it.
The results come back best first, and typing then narrows them like any fzf list.

## Try it

Requires Node.js 22 or newer, and fzf 0.66 or newer for the picker.
jevzf is not on npm yet; to try this checkout, pack it with the `decision-gate` package it is built on and install both:

```sh
npm pack --workspaces --include-workspace-root
npm install -g ./decision-gate-0.1.0.tgz ./jevzf-0.1.0.tgz
git log --oneline | jevzf                          # fzf; ctrl-s for meaning, then type and press enter
export TYPESAFE_API_KEY=...                        # console.typesafe.ai/settings/keys
git log --oneline | jevzf "when did we change the retry logic"   # the same search as a plain filter
```

Fuzzy and exact search, `--help` and `--estimate` need no key and no configuration.
`TYPESAFE_API_KEY` is the only setup meaning search needs.
The built-in secret filter, spend ceilings, rate limiter and answer cache are on without any configuration.

## The picker

`cmd | jevzf` shows the lines in fzf and prints the one you pick, as fzf does.

- `ctrl-s` cycles fuzzy, exact and meaning; `alt-f`, `alt-e` and `alt-m` jump straight to one.
- What you have typed stays through every switch.
- In meaning mode, Enter runs the search: never while you type, because every search is a paid request over the whole input.
- While it runs, the header shows its progress and matches appear as they are found; then the list is replaced by the ranked results and your words move to the header, so typing narrows the results.
- `alt-m` starts a new meaning search with the same words; Enter on a result picks it.
- The header shows what a search would cost before you press Enter, and what it cost after.
- Pressing Enter again with the same words over the same lines is free: answers are cached per line.

The picker copies stdin into a private temporary file and fzf lists that copy as it grows, so meaning search can read the lines again; the copy is deleted when fzf exits.
A meaning search on input that is still arriving runs on the complete lines so far and says so, as in `found in the first 120 lines so far`.
It talks to fzf over a Unix socket in that private directory, never a TCP port.
Without a key it still opens, and meaning mode says `Meaning search needs a TypeSafe key · export TYPESAFE_API_KEY` and sends nothing.
Your `FZF_DEFAULT_OPTS` still apply, and its header takes your terminal's own text colour unless your fzf options set one.
fzf is found on `PATH`, so a launcher with a minimal `PATH` has to put fzf on it.

## The filter

`cmd | jevzf QUERY...` is the same meaning search without fzf: it prints the matching lines, best first, byte for byte as they came in, the way `grep` or `fzf --filter` would.

Without a key, the filter sends nothing and exits 2:

```text
jevzf: meaning search needs a TypeSafe API key; nothing was sent.
  export TYPESAFE_API_KEY=...   (get one at console.typesafe.ai/settings/keys)
  To see what this search would cost first: jevzf --estimate 'when did we change the retry logic'
```

`--estimate` needs no key and sends nothing:

```sh
git log --oneline | jevzf --estimate "when did we change the retry logic"
```

## A binding for your own fzf

If you already run fzf over a source you can run again, such as `git log`, `rg` or `FZF_DEFAULT_COMMAND`, one binding adds meaning search to it without the picker.
fzf reads piped input only once, which is why piped text goes through the picker instead.
Ctrl-Space searches by meaning for what you have typed; Ctrl-F goes back to fzf's own fuzzy search.

```sh
SRC='git log --oneline'
eval "$SRC" | fzf \
    --bind "ctrl-space:reload($SRC | jevzf --closest 3 -- {q})+disable-search+change-prompt(meaning> )" \
    --bind "ctrl-f:reload($SRC)+enable-search+change-prompt(> )"
```

The search runs once per key press, never while you type, because every search is a paid request over the whole input.
Pressing Ctrl-Space again with the same words over the same lines is free: answers are cached per line.
The binding needs stock fzf with `disable-search`; there is no fork, patch or plugin.

## Options

```text
cmd | jevzf [options]             the picker
cmd | jevzf [options] QUERY...    the filter
```

- `--scores` (filter) prefixes each match with its probability and a tab, such as `0.83<TAB>`.
- `--floor P` sets the minimum probability for a match; the default is 0.58, the threshold Needle uses.
- `--closest N` shows the N best lines when none pass the floor; the default is 3 in the picker and 0 in the filter.
- `--max-cost USD` lowers this search's ceiling; it never raises it.
- `--no-cache` neither reads nor writes cached answers.
- `--read0` reads and writes NUL-separated records, as `fzf --read0` and `xargs -0` do.
- `--estimate` (filter) counts lines and how many are already cached, estimates the cost of the rest, names the ceilings and says how many lines the secret filter would change.
- `--help` and `--version` need no key.
- `--` ends the options, for a query that begins with a dash.

Exit codes follow grep and fzf: 0 at least one match, 1 nothing matched, 2 an error such as a bad flag, no key or every request failing, and 130 on Ctrl-C (143 on SIGTERM, 129 on SIGHUP).
The picker exits as fzf does: 0 when you pick a line, 1 when there was nothing to pick, and 130 on Escape or Ctrl-C.
A search stopped part-way by a ceiling prints what it found in the lines it judged and exits 0 or 1 by that, and stderr names the ceiling and how many lines went unjudged.
A search whose ceiling cannot cover even one request sends nothing and exits 2, rather than looking like a search that found nothing.

Lines are judged in input order, so when a ceiling stops a search it is the last lines that go unjudged; pipe through `tac` to judge the newest first.
ANSI colour codes are removed from what is sent and kept in what is printed.
Blank lines are skipped, and identical lines share one judgment.
Ties keep input order.
Input is limited to 10 MiB, 5,000 distinct lines and 24,000 bytes per line, with a query of up to 400 characters.

## Cost and ceilings

The picker's header and, when stderr is a terminal, the filter show the cost before sending and a summary after:

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
Before sending, stderr warns when a search may need more than its ceiling or what is left today, since each request first reserves its worst case.
The cost estimate and this warning count only lines not already cached, so repeating a search warns about nothing.
The daily ceiling covers the key: every tool that uses the same key and config counts against it together.
A search interrupted by Ctrl-C, ended by fzf's SIGTERM or cut off by a closed terminal closes its hold at what it may have spent; after kill -9 the hold is released after ten minutes, and anything it may have spent stays counted.
None of these leaves a lock behind: local state is locked only for the moment of each file update, never across a request, and a lock whose owner process is gone is reclaimed by the next search.
These are local ceilings, not account-wide billing controls.

## Rate limits

TypeSafe publishes 1,200 requests a minute and 250,000 tokens a second for `jev-1.13.0`.
jevzf keeps to 80% of both, counted across every process on the machine that uses the same key, so tools sharing a key stay under the limits together.
When TypeSafe answers 429 or 529, every process on that key pauses for the server's `retry-after`, and the official SDK retries the request.
One person's searches should never reach these limits; they matter when several tools share one key.

## Configuration

No configuration is needed.
To change the defaults, create `~/.config/decision-gate/config.json` (or `$XDG_CONFIG_HOME/decision-gate/config.json`) with any of these lines:

```json
{
  "key_file": "~/.config/decision-gate/key",
  "never_send_file": "~/.config/decision-gate/never-send.json",
  "spend": { "per_run_usd": 0.02, "per_day_usd": 0.2 },
  "limits": { "requests_per_minute": 1200, "tokens_per_second": 250000, "share": 0.8 }
}
```

The file belongs to [decision-gate](packages/decision-gate/README.md), so every tool built on it reads the same ceilings and limits; `per_run_usd` is jevzf's per-search ceiling.
`limits` describes your TypeSafe account, and `share` is the part of it those tools may use.
For one-off runs and CI, `DECISION_GATE_PER_RUN_USD`, `DECISION_GATE_PER_DAY_USD`, `DECISION_GATE_RPM` and `DECISION_GATE_TPS` override the file, and `DECISION_GATE_CONFIG` points at another file.
Relative paths in the file resolve beside it, and `~/` works.

The key comes from `TYPESAFE_API_KEY` first, then `key_file`, which must be mode 600; no other location is read.
Keep the key out of command arguments.

## Privacy

Meaning search sends the query and the lines to TypeSafe's HTTPS API.
Before anything is sent, a built-in filter replaces known secret formats in the query and every line.
The final check runs on the exact request body of every attempt, retries included, and refuses to send one in which a known secret survives.
The built-in filter recognises known formats only:

- PEM and PGP private-key blocks, including every line of a block piped in as separate lines; each line is judged by the key text at its end, so `rg -n` or `rg -C` paths (spaces included), `git diff` markers and `cat -n` numbers are kept and the key text is redacted; a block starts at a line whose last text is the BEGIN marker, so a multi-line quoted value such as a `.env` `PRIVATE_KEY="` or a triple-quoted or template string is covered while a one-line string constant holding only the marker is not, and runs to a line holding the END marker, whatever closes the value after it (such as `` `; `` or `""")`), or to the first line that is not key body when the key was cut off; a key held on one line with escaped `\n` newlines is redacted from BEGIN through END
- JWTs
- Prefixed API keys: OpenAI and Anthropic `sk-proj-`, `sk-svcacct-`, `sk-admin-`, `sk-None-` and `sk-ant-`, and any other `sk-` key of 20 or more characters with a capital letter and a digit, Stripe `sk_live_`/`sk_test_`, GitHub `ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_`/`github_pat_`, GitLab `glpat-`, npm `npm_`, Slack `xoxb-`/`xoxp-`/`xoxa-` and similar, AWS `AKIA`/`ASIA`, Google `AIza`
- `Bearer` tokens and `Authorization` header values
- Credentials in URLs and email addresses
- The value in pairs whose key contains password, passwd, pwd, secret, token, apikey or key as a whole segment (split by `_`, `-` or a case change, so `SECRET_KEY_BASE`, `apiKey`, `DBPassword` and `password_confirmation` count and `tokens` or `monkey` do not), after `=`, `:`, `:=`, `=>` or a comparison, whatever the spacing:
  - A quoted value is always redacted.
  - A bare value is redacted unless it is plainly code: an identifier with no digits; anything starting with `$` followed by letters, such as `$VAR` or `${VAR}`; dotted member access whose segments may contain digits, or indexing with anything inside the brackets, such as `os.environ['KEY']`; or any value containing `(`, which counts as a call.
    So `password = hunter2`, `aws_secret_access_key = wJal...` and `--token=abc123` are redacted, while `password=pw`, `token: string` and `api_key = get_key()` pass.
  - A bare value ends at whitespace, a comma, or a quote or bracket that closes one opened earlier on the line; a stray quote or bracket stays inside it.

A secret in no known format that is not on your never-send list is sent as written; add such values to the list, and choose input deliberately.

Known limits:

- A secret made only of letters, with no digits or punctuation, looks like an identifier and is sent, for example `password = hunter`.
- A secret under a key that names no secret word, such as `DB_PASS=...`, or with no `=` or `:` between key and value, such as `--password hunter2`, is sent.
- A number under a secret-named key is redacted, so `tokenCount = 5` loses its value.
- A private key whose body lines are each quoted or concatenated, such as `"MIIE...\n" +`, is not recognised line by line, so its body is sent.
- A typed declaration with a quoted default is sent, because the type name is taken as the value, for example `password: str = "hunter2secret"`.
- A value containing `(` is treated as a call and sent, for example `DB_PASSWORD=K9#m(Lq2!x`.
- A dotted value is treated as member access and sent, for example `password=Summer2024.Winter`.
- A value starting with `$` is treated as a variable and sent, for example `password=$ecretPass`.
- A bracketed value is treated as indexing and sent, for example `password=a[hunter2secret]`.
- An apostrophe earlier on the line, as in prose like "don't", can shift where a value ends, so part of it is sent.
- On the over-redaction side, `rg -n` output from an extensionless file named after a secret word loses its content, for example `bin/token:12:#!/bin/sh`.

For private values no pattern can know, such as names, customer ids or internal hosts, add a never-send list and point `never_send_file` or `DECISION_GATE_NEVER_SEND_FILE` at it (mode 600):

```json
{
  "rules": [["person", "(?i)Example Person", "[person]"]],
  "forbidden": ["(?i)Example Person"]
}
```

`rules` holds `[class, pattern, replacement]` entries, and `forbidden` lists patterns that must never reach a request.
Patterns are JavaScript regular expressions that also accept a leading `(?i)`, `(?m)` or `(?s)` and `\1` or `\g<name>` replacements; backslashes need escaping in JSON.
No filter can promise to find every private detail, so choose what you pipe in.

The answer cache in `~/.cache/decision-gate/answers` stores keyed hashes of lines and their probabilities for 30 days, never the query or the text, and stays under 50 MiB.
Spend and rate records in `~/.local/state/decision-gate` hold times, amounts and a fingerprint of the key, never the key or any text.
Either directory can be deleted while no search is running; deleting `spend` also forgets today's spending.

## Library

jevzf is built on [decision-gate](packages/decision-gate/README.md), which owns every call to Jev: the key, the secret filter, the ceilings, the rate limiter, the answer cache and the cost ledger.
Meaning search itself stays inside jevzf and has no public import path.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm pack --dry-run --workspaces --include-workspace-root
```

The repository is an npm workspace: jevzf at the root and decision-gate in `packages/decision-gate`, and `npm test` runs both.
decision-gate's one runtime dependency is TypeSafe's official SDK, `@typesafe-ai/sdk`, pinned to 0.6.0, which has no dependencies or install scripts of its own.
Tests use a loopback stand-in for TypeSafe and never a real key.
For tests only, `DECISION_GATE_ENDPOINT` may point at an HTTP URL on `127.0.0.1` or `::1`; any other host is refused, and redirects are never followed.
CI runs on Node.js 22, 24 and 26.

## Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please) from [Conventional Commits](https://www.conventionalcommits.org/) on `main`.
Pull request titles become the squash commit, so they must be Conventional Commits too (`feat: …`, `fix: …`).
The repository releases two packages, each with its own version and changelog: jevzf from the root, with tags `jevzf-v…`, and decision-gate from `packages/decision-gate`, with tags `decision-gate-v…`.
release-please keeps one standing release pull request that bumps both `package.json` files and writes each `CHANGELOG.md`; never edit a changelog by hand.
A commit counts for jevzf unless it only touches `packages/`, and for decision-gate when it touches `packages/decision-gate`.
Both are 0.x, so a breaking change raises the minor version rather than making 1.0.0.
When decision-gate releases, the workspace plugin raises jevzf's dependency on it and releases jevzf as a patch, so the two never drift apart.
Merging that pull request tags the releases, and the same workflow publishes them to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) and provenance, decision-gate first because jevzf depends on it.
No npm token is stored anywhere; npm trusts `.github/workflows/release-please.yml` in this repository for each package, so renaming that file breaks publishing.
npm only accepts a trusted publisher for a package that already exists, so each package's first version is published by hand before its trusted link is added.

## See also

[jgrep](https://github.com/keltokhy/jgrep) filters piped text by meaning with Jev, for anyone who wants a grep-focused tool.

## Licence and credits

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
jevzf is built for [fzf](https://github.com/junegunn/fzf) by Junegunn Choi.
Its meaning questions and 0.58 threshold come from Needle, by way of Dewey and herdr-find.

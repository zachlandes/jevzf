# jevzf

Pipe text in, describe what you want, get matching lines back in meaning order.
It works two ways, both supported: as a plain pipe filter, and inside your existing stock fzf through a key binding.
This project is unofficial, not affiliated with TypeSafe.

```sh
find . -type f | jevzf 'configuration files'
```

In fzf, a Ctrl-R binding ranks the candidates by the meaning of the current query; [With stock fzf](#with-stock-fzf) has the recipe.
That binding is the current way to use jevzf with fzf; a built-in fzf picker is coming.

## Try it

Requires Node.js 20 or newer.
The fzf example supports stock fzf 0.65 or newer; fzf is optional for the CLI itself.

```sh
# After the first npm release is published
npm install -g jevzf
printf '%s\n' 'reset password' 'garden tools' 'login service' | jevzf 'signing in'
```

Without a configured key, this prints the input unchanged and writes a first-run notice to stderr.
It sends nothing and does not look for credentials.
With meaning search configured below, it prints only matching lines, best-first.

This is a release candidate; it has not been published to npm yet.
To try this checkout before publication:

```sh
npm pack
npm install -g ./jevzf-0.1.0.tgz
```

## With stock fzf

This is the supported fzf integration today.
This POSIX-shell example saves the candidates once, keeps fzf's normal selection controls, and makes Ctrl-R request a meaning search for the current query.
There is no fzf fork, patch, wrapper mode, or request on each keystroke.

```sh
(
  export JEVZF_INPUT="$(mktemp)"
  trap 'rm -f "$JEVZF_INPUT"' EXIT
  find . -type f > "$JEVZF_INPUT"
  fzf --disabled --no-sort --query='configuration files' \
    --header='Type a meaning query; Ctrl-R searches; Enter selects' \
    --bind='ctrl-r:reload-sync(jevzf -- {q} < "$JEVZF_INPUT" || true)' \
    < "$JEVZF_INPUT"
)
```

`{q}` is fzf's shell-quoted query placeholder, not a string to interpolate yourself.
`--disabled` keeps fzf from hiding meaning matches with a second literal filter; `--no-sort` preserves jevzf's order.
The saved input makes every search cover the original candidates, not only the last result set.
The binding accepts an empty result without fzf's command-failed warning; jevzf still writes errors and spend notices to stderr.
Without a key, Ctrl-R reloads the unchanged candidates.

For a fixed query, pipe mode needs no binding:

```sh
find . -type f | jevzf 'configuration files' | fzf --no-sort
```

## Enable meaning search

Create a TypeSafe API key through [TypeSafe](https://console.typesafe.ai/), save it in a private file, and explicitly select that file.
Do not put the key value in a command argument.
jevzf does not read `TYPESAFE_API_KEY`, discover other tools' keys, or use a default key file.

```sh
export JEVZF_KEY_FILE="$HOME/.config/jevzf/key"
chmod 600 "$JEVZF_KEY_FILE"
printf '%s\n' 'reset password' 'garden tools' 'login service' | jevzf 'signing in'
```

That's all the required setup for meaning search.
Built-in secret and email redaction, spend caps and caching are on by default.
The private-file permission checks target macOS and Linux.

### Optional never-send list

For private values the built-in patterns cannot know, supply a redaction list.
The format is the same as herdr-find's: `rules` contains `[class, pattern, replacement]` arrays, and `forbidden` lists patterns that must not survive.
For example:

```json
{
  "rules": [["person", "(?i)Example Person", "[person]"]],
  "forbidden": ["(?i)Example Person"]
}
```

With no list configured, only the built-in rules apply.
Patterns use JavaScript regular expressions, with Python-style leading `(?i)`, `(?m)`, `(?s)` flags and `\1` / `\g<name>` replacements supported.
This is not a complete Python regex engine.
JSON backslashes need escaping, for example `"\\bExample\\b"`.

```sh
# After saving the optional list
export JEVZF_REDACTION_FILE="$HOME/.config/jevzf/redaction.json"
chmod 600 "$JEVZF_REDACTION_FILE"
```

### Optional configuration

No configuration file is required.
Alternatively, put the paths and caps in `$XDG_CONFIG_HOME/jevzf/config.json` (default `~/.config/jevzf/config.json`):

```json
{
  "key_file": "./key",
  "redaction_file": "./redaction.json",
  "search_cap_usd": 0.02,
  "daily_cap_usd": 0.2
}
```

Relative config paths resolve beside the config file; relative environment paths resolve from the working directory.
`~/` paths are supported.
`JEVZF_CONFIG` selects another config file; the file-path environment variables override config.
`JEVZF_SEARCH_CAP_USD` and `JEVZF_DAILY_CAP_USD` override the spend ceilings; defaults are $0.02 per search and $0.20 per rolling 24 hours without any configuration.
Invalid configuration or an explicitly configured but unreadable key fails without sending anything.

## Privacy, caps and caching

Meaning search sends the query and candidate text to TypeSafe's HTTPS API.
Built-in secret patterns and the configured rules redact the query, each line and question text before every request, including retries.
A forbidden-pattern check over decoded strings and the serialized body refuses the whole search before any request if a listed forbidden value survives.
The built-in filter recognises known formats only:

- PEM private-key blocks, including every line of a block piped in as separate lines
- JWTs
- Prefixed API keys: OpenAI and Anthropic `sk-proj-`, `sk-svcacct-`, `sk-admin-`, `sk-None-` and `sk-ant-`, and any other `sk-` key of 20 or more characters with a capital letter and a digit, Stripe `sk_live_`/`sk_test_`, GitHub `ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_`/`github_pat_`, GitLab `glpat-`, npm `npm_`, Slack `xoxb-`/`xoxp-`/`xoxa-` and similar, AWS `AKIA`/`ASIA`, Google `AIza`
- `Bearer` tokens and `Authorization` header values
- Credentials in URLs and email addresses
- The value in pairs whose key contains password, passwd, pwd, secret, token, apikey or key as a whole segment (split by `_`, `-` or a case change, so `SECRET_KEY_BASE`, `apiKey` and `password_confirmation` count and `tokens` or `monkey` do not):
  - Config form, `KEY=value` with no spaces around `=` (dotenv, shell, INI, `--token=...`): the whole value, up to whitespace, the end of the line, or a closing quote, bracket or brace
  - Code form, `key = value` with spaces, a comparison (`==`, `===`, `!=`, `!==`), `:=` or `=>`: only a quoted string literal, so names, calls and `await` expressions pass
  - After `:`: a quoted string literal, or a bare value of 12 or more characters with a digit, so type annotations such as `token: string` pass

A secret in no known format that is not on your never-send list is sent as written; add such values to the list, and choose input deliberately.
Output contains the original local lines, not redacted replacements.

Before sending, stderr shows **about** the estimated cost, the per-search cap, the rolling 24-hour cap and the remaining allowance.
The estimate uses a measured bytes-to-tokens ratio and is not a ceiling.
The caps are ceilings: each attempt reserves the pinned model's full documented request budget of 65,536 input tokens before sending, then replaces that reservation with reported usage.
At the documented price of $0.042 per million input tokens, a reservation is $0.002752512.
A search is refused before any request when its estimate plus one reservation exceeds the remaining allowance, and the error names the cap to raise.
The model is pinned to `jev-1.13.0`; [pricing and limits](https://docs.typesafe.ai/models) were checked on 2026-09-25.
A zero cap disables paid searches but still permits cache hits.
Retries use the official TypeSafe SDK's default policy: HTTP 408, 429 and 5xx and network failures are retried at most twice, honouring `Retry-After` up to 60 seconds.
Every attempt, including each retry, is separately checked against the caps and reserved, so retries can never pass a cap; uncertain failures keep their reservation.
Rate-limit and retry behaviour is not configurable in this release; a configurable rate limiter is planned.
No partial ranking is printed after an error or exhausted cap, and incomplete searches are not cached.

State lives in `$XDG_STATE_HOME/jevzf` (default `~/.local/state/jevzf`); `JEVZF_STATE_DIR` overrides it.
Spend reservations are persisted before requests and shared by CLI processes using that state directory.
Concurrent searches serialize, so they cannot each spend the same daily allowance.
These are local limits, not account-wide TypeSafe billing controls; another state directory, machine or application has separate accounting.

The last 100 complete searches are cached on the query plus the set of original nonblank lines, redaction rules, model, prompt revision and endpoint.
Repeating a search against the same set, even in a different order, makes no second call.
The cache stores a hash and scores, not the query or lines; hashes are not encryption.
State files are private to the user.
Delete only `cache.json` to clear cached rankings; a damaged `cache.json` is discarded and rebuilt with a one-line warning.
Deleting `spend.json` resets spend accounting, and a damaged `spend.json` refuses searches rather than resetting it.
A search that is interrupted or killed, for example by Ctrl-C or an fzf reload, frees its lock for the next search automatically and keeps its spend reservation.
Only a lock left on the same machine is reclaimed automatically; if a state directory shared between machines stays locked, the error names the lock to remove once no search is running.

## Input and exits

- UTF-8, newline-delimited text; CRLF is accepted, NUL input is rejected in meaning mode.
- Meaning mode skips blank lines and removes duplicate lines; no-key passthrough preserves input bytes.
- Limits: 10 MiB input, 5,000 distinct nonblank lines, 24,000 UTF-8 bytes per line, and a 400-character query.
  These are input ceilings, not a promise that a maximum-size input fits the default spend caps; a search the caps cannot cover is refused before sending.
- Results pass a Noul relevance threshold of 0.58 and are sorted by probability; ties sort by the original line text.
  This inherited starting threshold has not been calibrated for every kind of input.
- No automatic “nearest” fallback: if nothing passes, stdout is empty.
- Exit 0: matches or no-key passthrough; exit 1: no meaning matches; exit 2: invalid input, configuration, service, redaction or budget error.
- `--help` and `--version` need no key; `jevzf -- '-query'` accepts a query beginning with a dash.

## Development

The one runtime dependency is the official `@typesafe-ai/sdk`, pinned to 0.6.0, which has no runtime dependencies of its own.
There are no install hooks.
The core is internal to this repository, not a separate package; see [the internal API](https://github.com/zachlandes/jevzf/blob/main/docs/core.md).

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm pack --dry-run
```

Tests use a loopback stand-in, never a real Jev call.
For local tests only, `JEVZF_JEV_ENDPOINT` may select an HTTP URL on numeric loopback (`127.0.0.1` or `::1`); remote overrides and redirects are refused.
Never combine that test override with a real credential.
CI runs on Node.js 20, 22 and 24.

See also: [jgrep](https://github.com/keltokhy/jgrep) for grep-style filtering by meaning without fzf.

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
The meaning client, batching and redaction were adapted from herdr-find's meaning module, with question lineage through Dewey and Needle.

# Core library

`jevzf/core` is the package's one entry point for credentials, never-send checks, spend ceilings, rate limits, caching and Jev requests.
It is an internal layer with a public import path, not a separate package or a stable API before 1.0.
The CLI owns stdin, stdout and exit codes; fzf remains outside the core.

```js
import { openJev, searchByMeaning } from "jevzf/core";

const jev = openJev(); // TYPESAFE_API_KEY is enough
const result = await searchByMeaning({
  jev,
  query: "signing in",
  items: ["login service", "garden tools"],
  floor: 0.58,
  closest: 0
});
console.log(result.lines);
```

## Configuration and credentials

`openJev({ tool, key, neverSend, spend, env, notice })` opens a generic caller.
`tool` defaults to `jevzf` and identifies the caller's spend records, not a different service.
`notice` defaults to a no-op.
`spend` accepts `perSearchUsd` and `perDayUsd`, defaulting to USD 0.02 and USD 0.20.

Key precedence is an explicit `key: { file }`, `{ env }` or `{ value }`, then `TYPESAFE_API_KEY`, then the config's `key_file`.
Exactly one explicit source is allowed, and no other credential location is guessed.
Key files must be regular, nonempty files with mode 600.
`jev.status()` returns `{ ok: true }` or `{ ok: false, reason }` without reading the contents of a key file; `missing: true` marks the case where no key source is configured at all.
A status check cannot establish whether the service will accept a credential.
The key is read when a request or remaining-budget lookup first needs its fingerprint.

The one config file is `$XDG_CONFIG_HOME/jevzf/config.json`, normally `~/.config/jevzf/config.json`.
`JEVZF_CONFIG` overrides that location.
No file is required.

```json
{
  "key_file": "~/.config/jevzf/key",
  "never_send_file": "~/.config/jevzf/never-send.json",
  "spend": { "per_search_usd": 0.02, "per_day_usd": 0.2 },
  "limits": {
    "requests_per_minute": 1200,
    "tokens_per_second": 250000,
    "share": 0.8
  }
}
```

`JEVZF_PER_SEARCH_USD`, `JEVZF_PER_DAY_USD`, `JEVZF_RPM` and `JEVZF_TPS` override the corresponding config values.
The effective rate limits multiply the configured account limits by `share`.
Every tool reads the same limits section; explicit caller spend settings remain the caller's own.
Legacy v0 config and environment aliases remain accepted.

## Search and estimates

`searchByMeaning` accepts strings or objects with a `text` field.
The result's `matches` retain the original `item`, its input `index`, the original `line`, `lineIndex` and probability `p`.
`lines` is a convenience list of matching original text.
ANSI control sequences are removed only from text sent to the service.
Duplicate inputs retain their output positions; identical redacted text shares one judgment.

`floor` defaults to 0.58.
`closest` defaults to zero and supplies the best available results only when none pass the floor.
`pickLine: true` scores each nonblank line of a multiline item and returns its best line, with the original item and line index.
The neutral line prompt is versioned as `jevzf-line-v1`; its quality has not been measured on a scored set.

`capUsd` can lower the configured per-search ceiling, never raise it.
`noCache` disables both cache reads and writes.
`signal` cancels limiter waits and SDK requests.
`onFound` receives passing paid judgments as they arrive; `onProgress` receives judged/total counts and committed spend after each batch.
Up to eight batches of 16 items are in flight at once, dispatched in input order.
The returned list is sorted by probability, with input order breaking ties.

A full ceiling first waits for attempts in flight to settle, since they usually cost far less than their reservation.
It stops the search only when nothing is left in flight, returning what was judged with `stopped: true` and an `unjudged` count, and the notice names the ceiling, this search's or today's.
If the ceiling cannot cover even one request, so nothing was judged or sent, the search throws a `SpendCapError` instead.
`run.summary().ceiling` is `"day"` when what is left of today bounds the run and `"search"` otherwise.
Ordinary service failures return successful judgments when any exist, plus a failed-item count; if every request fails, the search throws.
A failed privacy check stops before sending any batch.
`estimateSearch({ jev, query, items, capUsd })` prepares the same requests but needs no key and sends nothing.
It reports estimated USD, configured ceilings and how many lines the never-send rules change.
The estimate is not a reservation or a promise about retries.

## Raw SDK requests

```js
const run = jev.run({ capUsd: 0.02 });
try {
  const answer = await run.ask({
    model: "jev-1.13.0",
    state: { text: "public example" },
    questions: {
      useful: { type: "noul", instructions: "Is the text useful?" }
    }
  });
  console.log(answer.answers.useful.noul);
} finally {
  await run.close();
}
```

Raw requests are checked, not silently rewritten.
A forbidden value in any serialized field or its decoded JSON form prevents the request.
Search performs redaction before this same final check.
Built-in rules cover known secret formats and email addresses, not arbitrary long hashes or random-looking strings, so file paths reach the service unchanged.
A private optional never-send file adds user rules and forbidden patterns.

Await `close()` to replace the run's hold with its committed cost.
`summary()` reports reserved/billed USD and billed input tokens without storing text.
Asks within one run may overlap: when the run's ceiling is full, an attempt waits for another to settle and is refused only when none is in flight.
`close()` waits for asks already made before it records the run's cost.
Use `describeError` for a safe diagnostic instead of logging a transport exception or provider response body.

## Request ownership and persisted state

The official `@typesafe-ai/sdk` owns serialization, timeouts, retries and Retry-After parsing.
The core explicitly sets its key, destination, model and logging level, so SDK environment defaults cannot redirect or log requests.
Its fetch wrapper checks the exact body, reserves the attempt against the run's ceiling, takes a shared rate slot and persists the reservation before every network attempt, including retries.
Redirects are never followed.
A 429 or 529 records a shared pause using the server's Retry-After delay, or a short fallback when absent, before SDK retry handling continues.

Rate state lives under `$XDG_STATE_HOME/jevzf/limits/<key-fingerprint>.json`.
The fingerprint is the first 16 SHA-256 hex characters, never the key.
Requests use a rolling minute window; tokens use a rolling second window, counting each request at its size in bytes, up to the 65,536-token request limit.
Measured usage is about a quarter token per byte, so this overcounts; the spend ceiling, not the limiter, is the guaranteed bound.
The defaults enforce 960 requests a minute and 200,000 reserved tokens a second.
If the limiter's directory cannot be written, it warns once per limiter and uses in-process limits.
This does not disable the daily ceiling: unwritable spend state still refuses paid requests.

Spend records live under `$XDG_STATE_HOME/jevzf/spend/<key-fingerprint>.jsonl` and contain tool, time, hold and cost, never text.
A run reserves its search allowance under a short filesystem lock so concurrent runs cannot allocate the same daily balance.
The daily boundary is UTC midnight.
Unused holds expire after ten minutes; booked attempts remain charged after a crash.
A resumed stale hold re-checks capacity before further spending.
The ledger keeps only today's and yesterday's records once older or superseded rows outnumber them.

Each read-modify-write of local state takes a lock directory for microseconds, never across a network call or sleep.
The lock is published with its owner already inside, so a crash cannot leave an ownerless lock.
A lock whose owner process is gone, or that is older than 30 seconds, is moved aside under a name tied to that owner, so two processes reclaiming the same stale lock cannot remove a newer one.

The reservation uses the pinned model's full documented request limit of 65,536 tokens, not an empirical bytes-per-token ratio.
Successful responses replace that reservation with reported input usage.
An uncertain attempt remains booked at its reservation.
This can refuse a very small allowance even when the displayed estimate is lower.

The per-item cache lives under `$XDG_CACHE_HOME/jevzf/answers`.
A private random hash key prevents guessing short source lines from stored hashes.
The query file hash includes the provider, model, prompt revision and never-send digest; entries hold only item hashes, probabilities and times.
Entries expire after 30 days, a file mostly made of expired or superseded rows is rewritten on its next write, and files are evicted to keep the cache within 50 MiB.
Re-running a query with new input sends only uncached items.
A cache write failure warns and continues without caching, not without spend accounting.

## Providers and dependency review

Only native TypeSafe is implemented.
The internal provider selection keeps endpoint, pinned model and SDK responder together; another provider needs a known price and comparable typed probabilities before it can support these ceilings and thresholds.
OpenRouter remains unverified and unsupported.

The pinned `@typesafe-ai/sdk` version is 0.6.0, with no runtime dependencies or install hooks.
Its published ESM entry point was inspected for credentials, logging, HTTP destinations, retries and filesystem or execution side effects.
SDK logging is explicitly off because debug logging can include request bodies.
All local state and key-file access belong to jevzf.

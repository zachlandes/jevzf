# Internal core

`lib/core.mjs` is the repository's one entry point for key handling, never-send checks, spend ceilings, caching and Jev requests.
It is an internal layer, not a separate package or a stable public library API.
The CLI owns stdin, stdout and exit codes; fzf remains outside the core.

```js
import { createSearch, describeError } from "../lib/core.mjs";

try {
  const engine = createSearch({
    env: process.env,
    notice: (message) => process.stderr.write(`${message}\n`)
  });
  const result = await engine.search({
    query: "signing in",
    lines: ["login service", "garden tools"]
  });
  console.log(result.lines);
} catch (error) {
  console.error(describeError(error));
}
```

`createSearch({ env, notice })` snapshots configuration and explicitly configured credentials.
`notice` is optional and defaults to a no-op.
With no configured key, `engine.enabled` is false and `search` returns the input lines unchanged without network or state writes.
The CLI uses `enabled` to stream untouched input bytes instead of buffering that passthrough.

`engine.search({ query, lines })` accepts a query string and an array of individual text lines.
Its result contains `lines`, `cached` and `spend` in USD; a completed paid search also includes reported input `tokens`.
No result contains the key.
Errors stop the search and return no partial ranking.
Use `describeError` for a display-safe message, not an arbitrary transport exception or response body.

## Request ownership

The official `@typesafe-ai/sdk` owns request serialization, timeout handling, retry policy and Retry-After parsing.
Its key, base URL, model and logging settings are all explicit; SDK environment defaults cannot select another credential or destination, or enable body logging.
The core's transport hook applies the never-send check and durably reserves the attempt immediately before each fetch, including SDK retries.
HTTP redirects are returned as errors without following them.
The SDK's default retry policy applies unchanged, including HTTP 429 and 529 with Retry-After; each retry is reserved like the first attempt.

`lib/meaning` contains the inherited redaction, question construction and accounting helpers.
`lib/state.mjs` serializes searches sharing a state directory and owns durable reservations and the result cache.
Its lock records the owning process, so a later search reclaims the lock of one that exited without releasing it.
A future key-fingerprint rate limiter belongs at the same pre-request hook, not in the CLI or fzf binding.
There is no rate limiter, OpenRouter adapter or separate core package in this release.

## Dependency review

The official TypeSafe documentation names `@typesafe-ai/sdk` and links its source at version 0.6.0.
The npm package has registry integrity metadata and provenance, no runtime dependency tree, and no install hooks.
The published ESM entry point was inspected for credential resolution, logging, HTTP destinations, retries and execution or filesystem side effects before adoption.
SDK logging is explicitly off because its debug mode includes request bodies.
All local state and credential-file access remain in jevzf, not the SDK.

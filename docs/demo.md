# First-release checks

An executable [showboat](https://github.com/simonw/showboat) demo of the filter, [demo/cli.md](demo/cli.md), shows the first run, the secret filter, the per-line cache, interrupts and spend ceilings against a loopback stand-in; `cd docs/demo && showboat verify cli.md` re-runs every block and checks its output.

## No-key first run

Install the packed release into a throwaway prefix, not the user's global installation.
Run from the repository root:

```sh
mkdir -p .tmp
npm ci --ignore-scripts
npm pack --pack-destination .tmp
npm install -g --ignore-scripts --no-audit --no-fund \
  --prefix "$PWD/.tmp/install" "$PWD/.tmp/jevzf-0.1.0.tgz"
printf 'garden tools\nlogin service\n' |
  env -i PATH="$PATH" HOME="$PWD/.tmp/empty-home" \
  .tmp/install/bin/jevzf 'signing in'
```

Captured stderr, with nothing on stdout, exit status 2, and no state or cache directory created:

```text
jevzf: meaning search needs a TypeSafe API key; nothing was sent.
  export TYPESAFE_API_KEY=...   (get one at console.typesafe.ai/settings/keys)
  To see what this search would cost first: jevzf --estimate 'signing in'
```

The same input with `--estimate` needs no key, sends nothing and exits 0:

```text
2 lines · 0 cached · about USD 0.000018 · never more than USD 0.02 per search · USD 0.20 per day · 0 lines changed by the never-send check
```

## Offline behavior and stock fzf

```sh
npm test
npm run lint
JEVZF_TEST_CLI="$PWD/.tmp/install/bin/jevzf" npm test
```

The CLI tests spawn real processes against a numeric-loopback HTTP stand-in.
They observe request bodies and authorization, original-line output, persisted reservations, cache hits, retry behavior, concurrent processes, recovery after killing a process during a request, and Ctrl-C both while reading stdin and during a request.
They also prove that configured SDK environment variables cannot redirect the credential or turn on body logging.
The core tests run the shared limiter in three separate processes, reclaim locks left by dead or stopped owners, compact the ledger and cache, and cancel a search mid-request.

When stock fzf 0.65 or newer and Python 3 are present, a PTY test runs the README's binding recipe, presses Ctrl-Space, waits for its reload, and presses Enter.
After the mocked meaning response, the selected output is `login service`, the second input line.
The query includes shell punctuation to exercise fzf's quoted `{q}` placeholder.
This test passed locally with fzf 0.73.1; it skips rather than pretends to test an absent or unsupported fzf.

## Live Jev check

The authorized synthetic check ran on 2026-09-26 against the first release candidate, before the core library described in [the core library](core.md), with the pinned `jev-1.13.0` through the official SDK.
No live check has been run against this core yet.
It sent one request over these made-up lines, with a $0.003 search ceiling and a $0.009 rolling-day ceiling:

```text
No space left on device while saving the report.
Incoming connections accepted on port 8080.
TLS handshake finished successfully.
Scheduled backup completed without errors.
CPU temperature returned to normal.
Authentication token expired.
Printer ran out of paper.
Wireless link dropped during upload.
Cache refreshed successfully.
Window resized to match the display.
Queue drained after the worker resumed.
Audio muted by the operator.
```

Query: `disk is full`.
The returned match was `No space left on device while saving the report.`, with probability **0.96**.
The remaining probabilities ranged from 0.02 to 0.06.
The inherited 0.58 floor was not changed.
The service reported 2,723 input tokens, costing **$0.000114366** at $0.042 per million input tokens.
The pre-search estimate was about $0.000108, not a ceiling.
Repeating the query with the same lines in reverse order returned the cached match, cost $0, and left the observed request count at one.

An earlier file-name-only check returned no matches: the best score was 0.57, just below the floor.
That request reported 2,708 input tokens and cost $0.000113736 at the same price.
The synthetic example proves a real paraphrase match, not general ranking quality or a calibrated threshold for arbitrary input.
No live calls are part of the tests or CI.

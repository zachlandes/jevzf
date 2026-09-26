# Fit and ownership

jevzf is Jev-powered search for fzf: pipe lines in, say what you mean, get the matching lines back.
Stock fzf owns interaction; the shell owns collecting candidates.
The filter and the fzf binding recipe are the command's whole surface in this release.

`jevzf/core` is the one owner of calling Jev, for this command and for other tools that adopt it.
It holds the key handling, the never-send check, the spend ceilings, the answer cache and the rate limiter, because each of those is only a guarantee if no caller can go around it.
A tool that kept its own copy would split the daily ceiling and the rate window into parts that cannot see each other.
The core is generic: a caller names itself with `tool` for its spend records and supplies its own key source and never-send list, and nothing in the core knows any particular caller.
It stays an internal layer of this package rather than a separate package until a second release cycle shows its interface holding still.

The core builds on TypeSafe's official SDK instead of beside it.
The SDK owns serialization, timeouts, retries and `retry-after` parsing.
jevzf wraps the SDK's `fetch`, so every attempt it makes, retries included, passes the never-send check, the ceilings and the limiter, and nothing reimplements what the SDK already does.

The secret filter recognises known formats only.
Guessing at long random strings would erase ordinary input such as commit hashes and file paths with digits, which an earlier heuristic did; a user who needs more has the never-send list.

Spend and rate limits live in the one config file, with environment overrides, and need no lines by default.
A second limits file would be a second place to look for no gain.

The spend ceiling reserves the pinned model's documented 65,536-token request limit for every attempt, not a measured bytes-per-token ratio.
The [TypeSafe model reference](https://docs.typesafe.ai/models) states: "64k tokens per request; 32k tokens for `state` plus the longest question".
A measured ratio is an estimate, and calling an estimate a ceiling would let a search pass it.
The rate limiter, whose failure mode is a 429 that pauses and retries, counts request bytes instead, so it does not throttle searches to the spend reservation's worst case.

Without a key, the filter sends nothing and exits 2 with the one line that fixes it.
Passing input through unchanged would look like a search that found everything.

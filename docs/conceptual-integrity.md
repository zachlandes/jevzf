# Fit and ownership

jevzf is Jev-powered search for fzf: pipe lines in, say what you mean, get the matching lines back.
Stock fzf owns interaction; the shell owns collecting candidates.
The command has three surfaces, and each exists for a reason the others cannot cover.

The picker, `cmd | jevzf`, is a thin wrapper around stock fzf rather than a fork or a new interface.
It exists because plain bindings cannot re-read piped stdin, which fzf consumes once, cannot show a search's progress, and cannot replace the list with the final ranking.
It adds only a private copy of the input, the meaning mode, and a Unix socket through which a running search updates fzf; fuzzy and exact are fzf's own.
Meaning search runs on Enter, never while typing, because each search is a paid request over the whole input.
The mode is called "meaning" rather than "jev" so that another provider can stand behind it later without renaming anything a user types.

The filter, `cmd | jevzf QUERY`, is the same search without fzf, and the picker's meaning mode runs through the same core call, so the two cannot drift apart.
The binding recipe serves people whose fzf already has a source it can run again, and needs no picker.

`decision-gate`, the second package in this repository, is the one owner of calling Jev, for this command and for the other tools that adopt it.
It holds the key handling, the never-send check, the spend ceilings, the rate limiter, the answer cache and the cost ledger, because each of those is only a guarantee if no caller can go around it.
A tool that kept its own copy would split the daily ceiling and the rate window into parts that cannot see each other.
It is a separate package rather than a layer of jevzf because tools unrelated to fzf should not install an fzf tool to spend a key.
The gate is generic: a caller names itself with `tool` for its spend records and supplies its own key source and never-send list, and nothing in the gate knows any particular caller.
Its answer cache is keyed by the caller and stores no text, so a caller's recipe decides what an answer means.
Anything that calls a generative model, stores request text or runs at development time stays outside it.

Meaning search is a recipe on top of the gate, not part of it, and stays inside jevzf with no public import path until its comparison reports.

The gate builds on TypeSafe's official SDK instead of beside it.
The SDK owns serialization, timeouts, retries and `retry-after` parsing.
The gate wraps the SDK's `fetch`, so every attempt, retries included, passes the never-send check, the ceilings and the limiter, and nothing reimplements what the SDK already does.

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

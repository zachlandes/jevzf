# Fit and ownership

The assigned first release was described as: “Pipe lines in, give a query, get meaning-ranked matches out.”
That is the boundary of this CLI.
It does not own a picker, pane navigation, transcript indexing or fzf modes.
Stock fzf owns interaction; the shell owns candidate collection.

The implementation extends the existing meaning-search concept from herdr-find rather than introducing a second ranking service.
`lib/core.mjs` owns the search operation, using the inherited meaning helpers and the official TypeSafe SDK.
The CLI only reads lines and prints the ranked originals.
The optional never-send list adds user-specific rules to the always-on built-in redaction.
The SDK owns retries and server-delay parsing; the core checks and reserves every attempt.
Cache and spend state share one serialized search path because independent paths could double-spend an allowance or repeat an identical request.

The earlier measured bytes/token reservation was not a ceiling.
The reused client now reserves the pinned model's documented full request token limit, persists that reservation before sending, and replaces it with reported usage after receiving a response.
The [TypeSafe model reference](https://docs.typesafe.ai/models) states: “64k tokens per request; 32k tokens for `state` plus the longest question”.
The implementation conservatively interprets 64k as 65,536 tokens.
This intentionally refuses very small allowances instead of calling an estimate an upper bound.

A missing configured key means byte-preserving passthrough with a notice, following the later adoption requirement.
An explicitly configured but invalid key remains an error rather than silently hiding a broken setup.

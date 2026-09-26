# jevzf filter: first run, privacy, ceilings and interrupts

*2026-09-26T05:48:33Z by Showboat 0.6.1*
<!-- showboat-id: 1c46b29f-e881-49ea-82b5-796990df10d4 -->

Every block runs the real CLI from this checkout through `stand-in.mjs`, a loopback stand-in for TypeSafe that answers by keyword. Nothing leaves the machine, no key is used and nothing is spent. Each block starts with empty state, cache and config. `$SENT` is every line the stand-in received.

## First run without a key

The filter sends nothing and says the one thing to do.

```bash
node stand-in.mjs 'printf "9f3c2a1 back off harder on 529s\n4b7e0d2 dark mode toggle\n" | TYPESAFE_API_KEY= jevzf when did we change the retry logic; echo "exit $?"; echo "lines sent: $(wc -l < "$SENT" | tr -d " ")"'
```

```output
jevzf: meaning search needs a TypeSafe API key; nothing was sent.
  export TYPESAFE_API_KEY=...   (get one at console.typesafe.ai/settings/keys)
  To see what this search would cost first: jevzf --estimate 'when did we change the retry logic'
exit 2
lines sent: 0
```

`--estimate` needs no key either, and says what the never-send check would change.

```bash
node stand-in.mjs 'printf "9f3c2a1 back off harder on 529s\n4b7e0d2 dark mode toggle\nb1e9d05 rotate api_key=Q7x9Lm2Kp4 in staging\n" | TYPESAFE_API_KEY= jevzf --estimate when did we change the retry logic'
```

```output
3 lines · 0 cached · about USD 0.000028 · never more than USD 0.02 per search · USD 0.20 per day · 1 line changed by the never-send check
```

## A search

Matches print best first, byte for byte, colour codes included; `--scores` adds the probability. The stand-in never saw the colour codes.

```bash
node stand-in.mjs 'printf "\033[33m9f3c2a1\033[0m back off harder on 529s\n4b7e0d2 dark mode toggle\n61b2d9f honour retry-after on webhooks\n" | jevzf --scores when did we change the retry logic | cat -v; echo "exit $?"; echo "--- sent:"; cat "$SENT"'
```

```output
0.93	^[[33m9f3c2a1^[[0m back off harder on 529s
0.93	61b2d9f honour retry-after on webhooks
exit 0
--- sent:
9f3c2a1 back off harder on 529s
4b7e0d2 dark mode toggle
61b2d9f honour retry-after on webhooks
```

## Known secret formats are replaced before sending

A GitHub-shaped token, an Authorization header, a password pair and an email are replaced; a digit-heavy file path and a commit hash pass unchanged. The output still carries the original lines.

```bash
node stand-in.mjs 'printf "%s\n" "retry: deploy with gh""p_Zq8Rk2Lm4Nx7Vb1Cd5Fg9Hj3Kp6Ws0Ty2Uw" "retry curl -H \"Authorization: Bearer abcdefghijklmnop\"" "retry password=hunter2x" "retry: ping ops@example.com" "./src/checkout/Step3ShippingAddress/Step3ShippingAddress.tsx" "9f3c2a1e4b7d retry backoff" > $HOME/in; jevzf retry < $HOME/in > /dev/null; echo "--- sent:"; sort "$SENT"'
```

```output
--- sent:
./src/checkout/Step3ShippingAddress/Step3ShippingAddress.tsx
9f3c2a1e4b7d retry backoff
retry curl -H "Authorization: [redacted]
retry password=[redacted]
retry: deploy with [github token]
retry: ping [email]
```

## The same search again is free

Answers are cached per line, so the repeat sends nothing and a new line is the only one sent.

```bash
node stand-in.mjs 'printf "back off on 529s\ndark mode\n" > $HOME/in; jevzf retry < $HOME/in; echo "sent after first: $(wc -l < "$SENT" | tr -d " ")"; jevzf retry < $HOME/in; echo "sent after repeat: $(wc -l < "$SENT" | tr -d " ")"; printf "retry uploads\n" >> $HOME/in; jevzf retry < $HOME/in; echo "sent after one new line: $(wc -l < "$SENT" | tr -d " ")"'
```

```output
back off on 529s
sent after first: 2
back off on 529s
sent after repeat: 2
back off on 529s
retry uploads
sent after one new line: 3
```

## Ctrl-C, an fzf reload's SIGTERM and a closed terminal's SIGHUP

Each signal arrives while a request is in flight (the stand-in never answers a search starting with "stuck"). The search exits with the shell's code for the signal, closes its spend hold at the one attempt that may have been billed, leaves no lock, and the next search runs at once.

```bash
node stand-in.mjs 'for sig in INT TERM HUP; do rm -f "$ARRIVED"; echo login | jevzf stuck on $sig & pid=$!; until [ -e "$ARRIVED" ]; do sleep 0.05; done; kill -$sig $pid; wait $pid; code=$?; node -e "const fs = require(\"fs\"), d = process.env.XDG_STATE_HOME + \"/jevzf/spend\"; const row = fs.readFileSync(d + \"/\" + fs.readdirSync(d).find((n) => n.endsWith(\".jsonl\")), \"utf8\").trim().split(\"\\n\").map(JSON.parse).at(-1); console.log(\"SIG$sig: exit $code, hold closed: \" + row.closed + \", held only what may have been billed: \" + (row.hold === row.usd) + \", other files beside the ledger: \" + fs.readdirSync(d).filter((n) => !n.endsWith(\".jsonl\")).length)"; echo login retry | jevzf retry after $sig > /dev/null && echo "  next search: exit $?"; done'
```

```output
SIGINT: exit 130, hold closed: true, held only what may have been billed: true, other files beside the ledger: 0
  next search: exit 0
SIGTERM: exit 143, hold closed: true, held only what may have been billed: true, other files beside the ledger: 0
  next search: exit 0
SIGHUP: exit 129, hold closed: true, held only what may have been billed: true, other files beside the ledger: 0
  next search: exit 0
```

## A large input that meets today's ceiling

With only a little of today's allowance left, a 200-line search warns first, prints the matches from the lines it could judge, and says which ceiling stopped it and how many lines went unjudged, in input order.

```bash
node stand-in.mjs 'awk "BEGIN { for (i = 0; i < 200; i++) print (i % 20 == 0 ? \"commit \" i \" retry uploads\" : \"commit \" i \" other work\") }" > $HOME/in; DECISION_GATE_PER_DAY_USD=0.003 jevzf retry < $HOME/in; echo "exit $?"'
```

```output
jevzf: this search may need more than the USD 0.003 left today; lines past it go unjudged, in input order
jevzf: stopped at today's spend ceiling; 152 lines unjudged (input order), results are from the lines before them
commit 0 retry uploads
commit 20 retry uploads
commit 40 retry uploads
exit 0
```

When the ceiling cannot cover even one request, the search sends nothing and exits 2, instead of looking like a search that found nothing.

```bash
node stand-in.mjs 'echo commit 1 retry uploads | DECISION_GATE_PER_DAY_USD=0.002 jevzf retry; echo "exit $?"; echo "lines sent: $(wc -l < "$SENT" | tr -d " ")"'
```

```output
jevzf: this search may need more than the USD 0.002 left today; lines past it go unjudged, in input order
jevzf: today's spend ceiling cannot cover one request, which reserves USD 0.0028; nothing was sent
exit 2
lines sent: 0
```

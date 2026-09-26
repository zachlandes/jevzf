# jevzf picker: stock fzf with a meaning mode

*2026-09-26T08:01:09Z by Showboat 0.6.1*
<!-- showboat-id: f4ffaacf-c49c-4932-82c0-8e79ce99e49b -->

`cmd | jevzf` opens stock fzf over piped text with three modes: fuzzy, exact and meaning. The screens below are the real picker in fzf, captured as text from a hidden tmux session and driven through the picker's own fzf socket against a loopback stand-in for TypeSafe, so nothing is sent and nothing is spent. Search times and the spinner are replaced with `N.N s` and `*` so the blocks re-run identically.

## The fzf it needs

The picker needs fzf 0.66 or newer, for its private Unix-socket `--listen`. An older fzf gets one line naming the fix, and the filter keeps working without fzf.

```bash
node stand-in.mjs 'printf "#!/bin/sh\necho \"0.65.2 (brew)\"\n" > "$HOME/fzf"; chmod +x "$HOME/fzf"; echo login | JEVZF_FZF="$HOME/fzf" jevzf; echo "exit $?"'
```

```output
jevzf: the picker needs fzf 0.66 or newer, found 0.65.2; install it with brew install fzf (or set JEVZF_FZF), or use the filter: cmd | jevzf QUERY
exit 2
```

## Fuzzy, then meaning, then results

Each case below is one picker session at 80 columns: fuzzy with typed words, the same words in meaning mode with the cost shown before anything is sent, the search running, and the ranked results with the words moved to the header.

```bash
T=$(mktemp -d) && sh ../../scripts/legibility-shots.sh --check --only wezterm-dark-80x24 "$T" > /dev/null && for s in fuzzy ask running results; do echo "--- $s"; sed -e 's/[0-9][0-9]*\.[0-9] s /N.N s /' -e 's/[⠀-⣿]/*/g' -e 's/ *$//' "$T/wezterm-dark-80x24-$s.txt" | sed -n 1,9p; done; rm -rf "$T"
```

```output
--- fuzzy
   fuzzy   exact   meaning    ctrl-s switch
  enter picks · alt-m searches by meaning
fuzzy> fix retry                                                           2/20
───────────────────────────────────────────────────────────────────────────────
▌ 61b2d9f fix: honour retry-after on rate-limited webhooks
▌ 7d20f5b fix: retry uploads that fail with a reset connection instead of sur··



--- ask
   fuzzy   exact   meaning    ctrl-s switch
  Type what you mean, then press enter · 20 lines
  about USD 0.00018 · never more than USD 0.02 per search · USD 0.20 left today
meaning> when did we change the retry logic                               20/20
───────────────────────────────────────────────────────────────────────────────
▌ 9f3c2a1 fix: back off harder on 529s from the model API                      │
▌ 4b7e0d2 feat: add dark mode toggle to settings                               │
▌ c81a9e4 chore: bump eslint to 9.12                                           │
▌ 7d20f5b fix: retry uploads that fail with a reset connection instead of sur··│
--- running
   fuzzy   exact   meaning    ctrl-s switch
  Searching for “when did we change the retry logic” by meaning…
filter>                                                                   * 0/0
───────────────────────────────────────────────────────────────────────────────





--- results
   fuzzy   exact   meaning    ctrl-s switch
  “when did we change the retry logic”: 3 found in 20 lines
  N.N s · USD 0.000235
  type to narrow · alt-m new search · enter picks
filter>                                                                     3/3
───────────────────────────────────────────────────────────────────────────────
▌ 9f3c2a1 fix: back off harder on 529s from the model API
▌ 7d20f5b fix: retry uploads that fail with a reset connection instead of sur··
▌ 61b2d9f fix: honour retry-after on rate-limited webhooks
```

## Without a key, and in narrow or plain terminals

Without a key the picker still opens and meaning mode says what to export. At 60 columns the header wraps between its parts, never through the key hint. Without a UTF-8 locale the separators and quotes fall back to ASCII and fzf draws without Unicode; under `NO_COLOR` the mode is marked in brackets.

```bash
T=$(mktemp -d) && sh ../../scripts/legibility-shots.sh --check --only wezterm-dark-80x24-nokey,wezterm-dark-60x24,wezterm-minimal-locale-80x24,wezterm-no-color-80x24 "$T" > /dev/null && for c in wezterm-dark-80x24-nokey-ask wezterm-dark-60x24-results wezterm-minimal-locale-80x24-results wezterm-no-color-80x24-results; do echo "--- $c"; sed -e 's/[0-9][0-9]*\.[0-9] s /N.N s /' -e 's/ *$//' "$T/$c.txt" | sed -n 1,7p; done; rm -rf "$T"
```

```output
--- wezterm-dark-80x24-nokey-ask
   fuzzy   exact   meaning    ctrl-s switch
  Meaning search needs a TypeSafe key · export TYPESAFE_API_KEY
meaning> when did we change the retry logic                               20/20
───────────────────────────────────────────────────────────────────────────────
▌ 9f3c2a1 fix: back off harder on 529s from the model API
▌ 4b7e0d2 feat: add dark mode toggle to settings
▌ c81a9e4 chore: bump eslint to 9.12
--- wezterm-dark-60x24-results
   fuzzy   exact   meaning    ctrl-s switch
  “when did we change the retry logic”: 3 found in 20 lines
  N.N s · USD 0.000235
  type to narrow · alt-m new search · enter picks
filter>                                                 3/3
───────────────────────────────────────────────────────────
▌ 9f3c2a1 fix: back off harder on 529s from the model API
--- wezterm-minimal-locale-80x24-results
   fuzzy   exact   meaning    ctrl-s switch
  "when did we change the retry logic": 3 found in 20 lines
  N.N s | USD 0.000235
  type to narrow | alt-m new search | enter picks
filter>                                                                     3/3
-------------------------------------------------------------------------------
> 9f3c2a1 fix: back off harder on 529s from the model API
--- wezterm-no-color-80x24-results
   fuzzy   exact  [meaning]   ctrl-s switch
  “when did we change the retry logic”: 3 found in 20 lines
  N.N s · USD 0.000235
  type to narrow · alt-m new search · enter picks
filter>                                                                     3/3
───────────────────────────────────────────────────────────────────────────────
▌ 9f3c2a1 fix: back off harder on 529s from the model API
```

## Real terminals

These are the captain's own screenshots, taken with `scripts/legibility-shots.sh` in WezTerm and Terminal.app. On light themes they showed the header in fzf's fixed grey-blue fading into the background, so the header now uses the terminal's own text colour; the shots below are from before that change.

```bash {image}
![Before: WezTerm Builtin Light, meaning mode, faint grey-blue header](before-wezterm-light-80x24-ask.png)
```

![Before: WezTerm Builtin Light, meaning mode, faint grey-blue header](292db550-2026-09-26.png)

```bash {image}
![Before: WezTerm Solarized Light, results, faint header](before-wezterm-solarized-light-80x24-results.png)
```

![Before: WezTerm Solarized Light, results, faint header](0c5a1faa-2026-09-26.png)

```bash {image}
![Before: Terminal.app Novel, results, faint header](before-terminal-novel-light-80x24-results.png)
```

![Before: Terminal.app Novel, results, faint header](15da5aaa-2026-09-26.png)

## After the header fix

The captain's re-run of the same script after the fix: every case in WezTerm and Terminal.app, across sizes (60, 80, 120 and 200 columns, and a 15-row window), light and dark themes, small and large fonts, 256 and 16 colours, NO_COLOR and a minimal locale. Terminal.app title bars are cropped.

```bash {image}
![After: WezTerm 16 colours, 80 columns by 24 rows, ranked results](wezterm-16-colour-80x24-results.png)
```

![After: WezTerm 16 colours, 80 columns by 24 rows, ranked results](45d78e2c-2026-09-26.png)

```bash {image}
![After: WezTerm 256 colours, 80 columns by 24 rows, ranked results](wezterm-256-colour-80x24-results.png)
```

![After: WezTerm 256 colours, 80 columns by 24 rows, ranked results](f5a2859b-2026-09-26.png)

```bash {image}
![After: WezTerm dark, 120 columns by 24 rows, ranked results](wezterm-dark-120x24-results.png)
```

![After: WezTerm dark, 120 columns by 24 rows, ranked results](f7d63cda-2026-09-26.png)

```bash {image}
![After: WezTerm dark, 200 columns by 24 rows, ranked results](wezterm-dark-200x24-results.png)
```

![After: WezTerm dark, 200 columns by 24 rows, ranked results](43d59403-2026-09-26.png)

```bash {image}
![After: WezTerm dark, 60 columns by 24 rows, meaning mode, cost shown before sending](wezterm-dark-60x24-ask.png)
```

![After: WezTerm dark, 60 columns by 24 rows, meaning mode, cost shown before sending](92651c81-2026-09-26.png)

```bash {image}
![After: WezTerm dark, 60 columns by 24 rows, ranked results](wezterm-dark-60x24-results.png)
```

![After: WezTerm dark, 60 columns by 24 rows, ranked results](3211a72c-2026-09-26.png)

```bash {image}
![After: WezTerm dark, 80 columns by 15 rows (short window), meaning mode, cost shown before sending](wezterm-dark-80x15-short-ask.png)
```

![After: WezTerm dark, 80 columns by 15 rows (short window), meaning mode, cost shown before sending](a51eeb20-2026-09-26.png)

```bash {image}
![After: WezTerm dark, 80 columns by 15 rows (short window), ranked results](wezterm-dark-80x15-short-results.png)
```

![After: WezTerm dark, 80 columns by 15 rows (short window), ranked results](effdfa27-2026-09-26.png)

```bash {image}
![After: WezTerm dark, 80 columns by 24 rows, meaning mode, cost shown before sending](wezterm-dark-80x24-ask.png)
```

![After: WezTerm dark, 80 columns by 24 rows, meaning mode, cost shown before sending](4d47b416-2026-09-26.png)

```bash {image}
![After: WezTerm dark, 80 columns by 24 rows, fuzzy mode](wezterm-dark-80x24-fuzzy.png)
```

![After: WezTerm dark, 80 columns by 24 rows, fuzzy mode](f82bfe92-2026-09-26.png)

```bash {image}
![After: WezTerm dark, 80 columns by 24 rows, no key, meaning mode, cost shown before sending](wezterm-dark-80x24-nokey-ask.png)
```

![After: WezTerm dark, 80 columns by 24 rows, no key, meaning mode, cost shown before sending](e07bce56-2026-09-26.png)

```bash {image}
![After: WezTerm dark, 80 columns by 24 rows, ranked results](wezterm-dark-80x24-results.png)
```

![After: WezTerm dark, 80 columns by 24 rows, ranked results](261bed95-2026-09-26.png)

```bash {image}
![After: WezTerm dark, 80 columns by 24 rows, search running](wezterm-dark-80x24-running.png)
```

![After: WezTerm dark, 80 columns by 24 rows, search running](1719e3b9-2026-09-26.png)

```bash {image}
![After: WezTerm large font, 80 columns by 24 rows, ranked results](wezterm-font-large-80x24-results.png)
```

![After: WezTerm large font, 80 columns by 24 rows, ranked results](3b409b05-2026-09-26.png)

```bash {image}
![After: WezTerm small font, 80 columns by 24 rows, ranked results](wezterm-font-small-80x24-results.png)
```

![After: WezTerm small font, 80 columns by 24 rows, ranked results](ee51b780-2026-09-26.png)

```bash {image}
![After: WezTerm Builtin Light, 80 columns by 24 rows, meaning mode, cost shown before sending](wezterm-light-80x24-ask.png)
```

![After: WezTerm Builtin Light, 80 columns by 24 rows, meaning mode, cost shown before sending](4fd026fa-2026-09-26.png)

```bash {image}
![After: WezTerm Builtin Light, 80 columns by 24 rows, ranked results](wezterm-light-80x24-results.png)
```

![After: WezTerm Builtin Light, 80 columns by 24 rows, ranked results](86605f81-2026-09-26.png)

```bash {image}
![After: WezTerm no UTF-8 locale, 80 columns by 24 rows, meaning mode, cost shown before sending](wezterm-minimal-locale-80x24-ask.png)
```

![After: WezTerm no UTF-8 locale, 80 columns by 24 rows, meaning mode, cost shown before sending](f08c34bf-2026-09-26.png)

```bash {image}
![After: WezTerm no UTF-8 locale, 80 columns by 24 rows, ranked results](wezterm-minimal-locale-80x24-results.png)
```

![After: WezTerm no UTF-8 locale, 80 columns by 24 rows, ranked results](e9dca369-2026-09-26.png)

```bash {image}
![After: WezTerm NO_COLOR, 80 columns by 24 rows, meaning mode, cost shown before sending](wezterm-no-color-80x24-ask.png)
```

![After: WezTerm NO_COLOR, 80 columns by 24 rows, meaning mode, cost shown before sending](a4dc5755-2026-09-26.png)

```bash {image}
![After: WezTerm NO_COLOR, 80 columns by 24 rows, ranked results](wezterm-no-color-80x24-results.png)
```

![After: WezTerm NO_COLOR, 80 columns by 24 rows, ranked results](1f81f227-2026-09-26.png)

```bash {image}
![After: WezTerm Solarized Light, 80 columns by 24 rows, ranked results](wezterm-solarized-light-80x24-results.png)
```

![After: WezTerm Solarized Light, 80 columns by 24 rows, ranked results](89566fbf-2026-09-26.png)

```bash {image}
![After: Terminal.app Basic profile, 120 columns by 24 rows, ranked results](terminal-basic-120x24-results.png)
```

![After: Terminal.app Basic profile, 120 columns by 24 rows, ranked results](e27747d3-2026-09-26.png)

```bash {image}
![After: Terminal.app Basic profile, 16 colours, 80 columns by 24 rows, ranked results](terminal-basic-16-colour-80x24-results.png)
```

![After: Terminal.app Basic profile, 16 colours, 80 columns by 24 rows, ranked results](160cd446-2026-09-26.png)

```bash {image}
![After: Terminal.app Basic profile, 200 columns by 24 rows, ranked results](terminal-basic-200x24-results.png)
```

![After: Terminal.app Basic profile, 200 columns by 24 rows, ranked results](20fc08d4-2026-09-26.png)

```bash {image}
![After: Terminal.app Basic profile, 60 columns by 24 rows, meaning mode, cost shown before sending](terminal-basic-60x24-ask.png)
```

![After: Terminal.app Basic profile, 60 columns by 24 rows, meaning mode, cost shown before sending](6c6a1acd-2026-09-26.png)

```bash {image}
![After: Terminal.app Basic profile, 60 columns by 24 rows, ranked results](terminal-basic-60x24-results.png)
```

![After: Terminal.app Basic profile, 60 columns by 24 rows, ranked results](99842667-2026-09-26.png)

```bash {image}
![After: Terminal.app Basic profile, 80 columns by 15 rows (short window), meaning mode, cost shown before sending](terminal-basic-80x15-short-ask.png)
```

![After: Terminal.app Basic profile, 80 columns by 15 rows (short window), meaning mode, cost shown before sending](5f927b53-2026-09-26.png)

```bash {image}
![After: Terminal.app Basic profile, 80 columns by 15 rows (short window), ranked results](terminal-basic-80x15-short-results.png)
```

![After: Terminal.app Basic profile, 80 columns by 15 rows (short window), ranked results](682af558-2026-09-26.png)

```bash {image}
![After: Terminal.app Basic profile, 80 columns by 24 rows, meaning mode, cost shown before sending](terminal-basic-80x24-ask.png)
```

![After: Terminal.app Basic profile, 80 columns by 24 rows, meaning mode, cost shown before sending](4084910a-2026-09-26.png)

```bash {image}
![After: Terminal.app Basic profile, 80 columns by 24 rows, fuzzy mode](terminal-basic-80x24-fuzzy.png)
```

![After: Terminal.app Basic profile, 80 columns by 24 rows, fuzzy mode](4ce0d76d-2026-09-26.png)

```bash {image}
![After: Terminal.app Basic profile, 80 columns by 24 rows, no key, meaning mode, cost shown before sending](terminal-basic-80x24-nokey-ask.png)
```

![After: Terminal.app Basic profile, 80 columns by 24 rows, no key, meaning mode, cost shown before sending](ed9d46fb-2026-09-26.png)

```bash {image}
![After: Terminal.app Basic profile, 80 columns by 24 rows, ranked results](terminal-basic-80x24-results.png)
```

![After: Terminal.app Basic profile, 80 columns by 24 rows, ranked results](e50b239f-2026-09-26.png)

```bash {image}
![After: Terminal.app Basic profile, 80 columns by 24 rows, search running](terminal-basic-80x24-running.png)
```

![After: Terminal.app Basic profile, 80 columns by 24 rows, search running](cca94fcd-2026-09-26.png)

```bash {image}
![After: Terminal.app no UTF-8 locale, 80 columns by 24 rows, meaning mode, cost shown before sending](terminal-minimal-locale-80x24-ask.png)
```

![After: Terminal.app no UTF-8 locale, 80 columns by 24 rows, meaning mode, cost shown before sending](60ef5728-2026-09-26.png)

```bash {image}
![After: Terminal.app no UTF-8 locale, 80 columns by 24 rows, ranked results](terminal-minimal-locale-80x24-results.png)
```

![After: Terminal.app no UTF-8 locale, 80 columns by 24 rows, ranked results](bdbafa1d-2026-09-26.png)

```bash {image}
![After: Terminal.app NO_COLOR, 80 columns by 24 rows, ranked results](terminal-no-color-80x24-results.png)
```

![After: Terminal.app NO_COLOR, 80 columns by 24 rows, ranked results](95321ad8-2026-09-26.png)

```bash {image}
![After: Terminal.app Novel profile, 80 columns by 24 rows, ranked results](terminal-novel-light-80x24-results.png)
```

![After: Terminal.app Novel profile, 80 columns by 24 rows, ranked results](2fb0a3a3-2026-09-26.png)

```bash {image}
![After: Terminal.app Pro profile, 80 columns by 24 rows, meaning mode, cost shown before sending](terminal-pro-dark-80x24-ask.png)
```

![After: Terminal.app Pro profile, 80 columns by 24 rows, meaning mode, cost shown before sending](09117262-2026-09-26.png)

```bash {image}
![After: Terminal.app Pro profile, 80 columns by 24 rows, ranked results](terminal-pro-dark-80x24-results.png)
```

![After: Terminal.app Pro profile, 80 columns by 24 rows, ranked results](bf4ccbec-2026-09-26.png)

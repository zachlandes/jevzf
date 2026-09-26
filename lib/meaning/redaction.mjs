import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

// Adapted from herdr-find 4736dd5 (Apache-2.0)

// Redaction for everything a meaning search sends, in two layers: secret shapes built in here,
// then the user's own value list (names, customer ids, domains no pattern can know). A fail-closed
// sweep follows: a request in which any forbidden pattern survives is never sent. No rule, pattern
// or match is ever printed; a report names rule classes and counts, nothing else.
//
// The value list uses Dewey's format:
//
//   { "rules": [[class, pattern, replacement], ...], "forbidden": [pattern, ...] }
//
// Patterns are Python-flavoured regular expressions; a leading inline flag group such as (?i)
// becomes a JavaScript flag. Replacements use Python's \1 and \g<name> group syntax.

export class RedactionError extends Error {}

// A secret word as a whole segment of a key, split by _ or - or a case change, so SECRET_KEY_BASE,
// apiKey and password_confirmation qualify and tokens, monkey and keyboard do not
const SECRET_SEGMENT = String.raw`(?:(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|token|apikey|key)(?![a-z])|(?<![A-Z])(?:Password|Passwd|Pwd|Secret|Token|Apikey|Key)(?![a-z])|(?<![A-Za-z0-9])(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|APIKEY|KEY)(?![A-Za-z]))`;

// Known secret formats only, applied before the user's rules to whole texts. A secret in no listed
// format and not on the user's list is sent; guessing at random-looking strings erased file paths.
export const BUILT_IN_RULES = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, "[private key]"],
  // The value only, judged by form. Config form (KEY=value, no spaces around =) takes the whole
  // value; code form (spaces around =, comparisons, :=, =>) takes only a quoted literal, so names,
  // calls and awaits pass; after : a quoted literal or a bare token of 12 or more with a digit.
  // Runs before the prefixed formats so a variable holding one loses its whole value
  ["secret-pair", new RegExp(String.raw`((?<![A-Za-z0-9_-])[A-Za-z0-9_-]+(?![A-Za-z0-9_-])(?<=${SECRET_SEGMENT}[A-Za-z0-9_-]*)["']?(?:=(?=[^=>\s])|\s*(?:===|!==|==|!=|=>|:=|=|:)\s*))(?:(["'\`])(?:\\.|(?!\2)[^\\\n])*(?:\2|(?=\n)|$)|(?<=[^\s=!:<>]=)(?:[^\s"'\`\[\]{}()]|\[[^\s"'\`\]]*\]|\([^\s"'\`)]*\)|\{[^\s"'\`}]*\})+|(?<=:\s*)(?=[^\s;,)}\]"'\`]{12})(?=[^\s;,)}\]"'\`]*[0-9])[^\s;,)}\]"'\`]+)`, "g"), "$1$2[redacted]$2"],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[token]"],
  ["bearer", /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [token]"],
  ["authorization", /\b((?:proxy-)?authorization\s*[:=]\s*)(?:(?:basic|bearer|token)\s+)?\S+/gi, "$1[redacted]"],
  // OpenAI and Anthropic: a known label with any base64url body, or any body with a capital and a
  // digit; kebab-case names such as sk-learn-model-v2.py are lowercase and pass
  ["api-key", /\bsk-(?:(?:proj|svcacct|admin|None|ant-[a-z]+[0-9]*)-[A-Za-z0-9_-]{20,}|(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,})/g, "[api key]"],
  ["api-key", /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[api key]"],
  ["github-token", /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[github token]"],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g, "[gitlab token]"],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}/g, "[npm token]"],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[slack token]"],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}/g, "[aws key]"],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}/g, "[google key]"],
  ["url-credentials", /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1[redacted]@"],
  // Pixel-density image names such as logo@2x.png are not addresses
  ["email", /\b[A-Za-z0-9._%+-]+@(?![0-9]+(?:\.[0-9]+)?[xX]\.(?:[pP][nN][gG]|[jJ][pP][eE]?[gG]|[gG][iI][fF]|[wW][eE][bB][pP]|[sS][vV][gG]|[aA][vV][iI][fF])\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, "[email]"]
];

// A private key piped in as several lines: every line from its BEGIN marker to its END marker, or
// to the end of the input when the block is cut off, since the body lines carry the key itself
export function privateKeyLines(lines) {
  const inside = new Set();
  let open = false;
  for (const line of lines) {
    const begin = line.search(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/);
    if (!open && begin < 0) continue;
    inside.add(line);
    open = !/-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(open ? line : line.slice(begin));
  }
  return inside;
}

// Shapes that must never survive redaction, whatever the user's list says
export const BUILT_IN_FORBIDDEN = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bsk-(?:(?:proj|svcacct|admin|None|ant-[a-z]+[0-9]*)-[A-Za-z0-9_-]{20,}|(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,})/,
  /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /\bAIza[0-9A-Za-z_-]{35}/
];

function compile(pattern, extra = "") {
  if (typeof pattern !== "string") throw new RedactionError("redaction patterns must be strings");
  const match = pattern.match(/^\(\?([aimsux]+)\)/);
  const flags = new Set(extra);
  let source = pattern;
  if (match) {
    source = pattern.slice(match[0].length);
    for (const flag of match[1]) {
      if (flag === "i" || flag === "m" || flag === "s") flags.add(flag);
      else if (flag !== "u" && flag !== "a") throw new RedactionError("a redaction pattern uses an unsupported inline flag");
    }
  }
  // Unicode mode where the pattern allows it, since Python matches by code point; a pattern with
  // an escape unicode mode rejects (such as \-) compiles without it
  for (const mode of ["u", ""]) {
    try {
      return new RegExp(source, [...flags].join("") + mode);
    } catch { /* try the next mode */ }
  }
  // The pattern itself is private, so the error does not quote it
  throw new RedactionError("a redaction pattern does not compile as a JavaScript regular expression");
}

// Python's replacement syntax: \1, \g<1> and \g<name> insert a group, \\ a backslash; nothing
// else is special, and a JavaScript $ stays literal
function expand(replacement, match) {
  const named = typeof match[match.length - 1] === "object" ? match[match.length - 1] : {};
  return replacement.replace(/\\(?:g<(\w+)>|(\d{1,2})|(\\))/g, (_all, name, number, slash) => {
    if (slash) return "\\";
    const key = name ?? number;
    const value = /^\d+$/.test(key) ? match[Number(key)] : named?.[key];
    return value ?? "";
  });
}

export function createRedactor(spec = { rules: [], forbidden: [] }) {
  if (!spec || !Array.isArray(spec.rules) || !Array.isArray(spec.forbidden)) throw new RedactionError("the redaction file must hold rules and forbidden arrays");
  const rules = spec.rules.map((rule, index) => {
    if (!Array.isArray(rule) || rule.length !== 3 || rule.some((part) => typeof part !== "string")) throw new RedactionError(`redaction rule ${index + 1} must be [class, pattern, replacement]`);
    return { cls: rule[0], pattern: compile(rule[1], "g"), replacement: rule[2] };
  });
  const forbidden = [...BUILT_IN_FORBIDDEN, ...spec.forbidden.map((pattern) => compile(pattern))];
  const counts = Object.create(null);
  const count = (cls) => { counts[cls] = (counts[cls] ?? 0) + 1; };
  const redact = (text) => {
    let out = text;
    for (const [cls, pattern, replacement] of BUILT_IN_RULES) {
      out = out.replace(pattern, (...match) => { count(cls); return replacement.replace(/\$(\d)/g, (_all, n) => match[Number(n)] ?? ""); });
    }
    for (const rule of rules) {
      out = out.replace(rule.pattern, (...match) => { count(rule.cls); return expand(rule.replacement, match); });
    }
    return out;
  };
  return {
    redact,
    fingerprint: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
    // True when nothing forbidden survives; the caller must not send a body that fails
    clean: (text) => forbidden.every((pattern) => !pattern.test(text)),
    counts: () => ({ ...counts }),
    size: { rules: BUILT_IN_RULES.length + rules.length, forbidden: forbidden.length }
  };
}

export function loadRedactor(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new RedactionError("cannot read the configured redaction file");
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new RedactionError("the redaction file must be a private regular file (chmod 600)");
  let spec;
  try {
    spec = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new RedactionError("the redaction file is not valid JSON");
  }
  return createRedactor(spec);
}

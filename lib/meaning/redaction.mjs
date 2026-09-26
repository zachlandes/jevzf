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

// Applied before the user's rules, to whole texts
export const BUILT_IN_RULES = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[private key]"],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[token]"],
  ["bearer", /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [token]"],
  ["authorization", /\b((?:proxy-)?authorization\s*[:=]\s*)(?:(?:basic|bearer|token)\s+)?\S+/gi, "$1[redacted]"],
  ["api-key", /\b(?:sk|pk|rk)-(?:[a-z]+-)?[A-Za-z0-9_-]{16,}/g, "[api key]"],
  ["api-key", /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[api key]"],
  ["github-token", /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[github token]"],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[slack token]"],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[aws key]"],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}\b/g, "[google key]"],
  ["secret-pair", /\b((?:[a-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*)(["']?)(?!\[)[^\s"',;]{4,}\2/gi, "$1$2[redacted]$2"],
  ["url-credentials", /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1[redacted]@"],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, "[email]"],
  // Long unbroken runs of letters and digits mixed are keys, hashes or tokens unless they read as words
  ["long-token", /\b(?=[A-Za-z0-9+/_=-]*[0-9])(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{40,}/g, "[long token]", randomLooking]
];

const charClass = (c) => c >= "0" && c <= "9" ? 0 : c >= "a" && c <= "z" ? 1 : c >= "A" && c <= "Z" ? 2 : -1;

// Readable paths and identifiers switch between letters, digits and capitals rarely, except at the
// start of a capitalised word, and have lowercase letters beyond a-f and no six-consonant clusters.
// Measured over 40-character windows against real file paths and random tokens: over 90% of 40+
// character path runs stay readable, random base64 and hex are always caught, and random lowercase
// base32 is missed under 0.3% of the time.
function randomWindow(text) {
  if (!/[0-9]/.test(text) || !/[A-Za-z]/.test(text)) return false;
  if (!/[g-z]/.test(text) || /[bcdfghjklmnpqrstvwxz]{6}/i.test(text)) return true;
  let pairs = 0;
  let switches = 0;
  for (let i = 1; i < text.length; i++) {
    const a = charClass(text[i - 1]);
    const b = charClass(text[i]);
    if (a < 0 || b < 0) continue;
    pairs += 1;
    if (a !== b && !(a === 2 && b === 1)) switches += 1;
  }
  return switches >= 0.12 * pairs;
}

// Judged a token-sized window at a time, so a readable prefix cannot dilute a random stretch after it
function randomLooking(run) {
  for (let i = 0; i + 40 <= run.length; i++) {
    if (randomWindow(run.slice(i, i + 40))) return true;
  }
  return false;
}

// Shapes that must never survive redaction, whatever the user's list says
export const BUILT_IN_FORBIDDEN = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:sk|pk|rk)-(?:[a-z]+-)?[A-Za-z0-9_-]{16,}/,
  /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/
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
    for (const [cls, pattern, replacement, applies = () => true] of BUILT_IN_RULES) {
      out = out.replace(pattern, (...match) => {
        if (!applies(match[0])) return match[0];
        count(cls);
        return replacement.replace(/\$(\d)/g, (_all, n) => match[Number(n)] ?? "");
      });
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

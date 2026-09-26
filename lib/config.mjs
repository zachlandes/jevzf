import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export class ConfigError extends Error {}
export const expandHome = (value) => value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;

export function amount(value, name, { positive = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) throw new ConfigError(`${name} must be a ${positive ? "positive" : "nonnegative"} number`);
  return value;
}

export function loadConfig(env = process.env) {
  const file = env.JEVZF_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "jevzf", "config.json");
  let user = {};
  try { user = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT" || env.JEVZF_CONFIG) throw new ConfigError("cannot read config as JSON");
  }
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  if (!object(user) || (user.spend !== undefined && !object(user.spend)) || (user.limits !== undefined && !object(user.limits))) throw new ConfigError("config, spend and limits must be objects");
  const number = (name, fallback, label, positive = false) => amount(env[name] !== undefined ? (env[name].trim() ? Number(env[name]) : NaN) : fallback, label, { positive });
  const location = (value, fromEnv, label) => {
    if (value === null) return null;
    if (typeof value !== "string" || !value.trim()) throw new ConfigError(`${label} must be a path`);
    return path.resolve(fromEnv ? process.cwd() : path.dirname(file), expandHome(value));
  };
  const share = amount(user.limits?.share ?? 0.8, "limits.share", { positive: true });
  if (share > 1) throw new ConfigError("limits.share must not exceed 1");
  return {
    key_file: location(user.key_file ?? null, false, "key_file"),
    never_send_file: location(env.JEVZF_NEVER_SEND_FILE || user.never_send_file || null, !!env.JEVZF_NEVER_SEND_FILE, "never_send_file"),
    spend: {
      perSearchUsd: number("JEVZF_PER_SEARCH_USD", user.spend?.per_search_usd ?? 0.02, "per-search ceiling"),
      perDayUsd: number("JEVZF_PER_DAY_USD", user.spend?.per_day_usd ?? 0.2, "daily ceiling")
    },
    limits: {
      requestsPerMinute: number("JEVZF_RPM", user.limits?.requests_per_minute ?? 1200, "requests per minute", true),
      tokensPerSecond: number("JEVZF_TPS", user.limits?.tokens_per_second ?? 250000, "tokens per second", true),
      share
    },
    stateDir: location(env.JEVZF_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "jevzf"), true, "state directory"),
    cacheDir: location(path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "jevzf", "answers"), true, "cache directory")
  };
}

function privateFile(file) {
  const stat = statSync(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new ConfigError("key file must be a private regular file (chmod 600)");
  if (!stat.size) throw new ConfigError("key file must contain one nonempty line");
}

export function keySource(explicit, config, env) {
  const source = explicit ?? (env.TYPESAFE_API_KEY?.trim() ? { env: "TYPESAFE_API_KEY" } : config.key_file ? { file: config.key_file } : null);
  if (source !== null && (typeof source !== "object" || Object.keys(source).length !== 1 || !["file", "env", "value"].includes(Object.keys(source)[0]) || typeof Object.values(source)[0] !== "string")) throw new ConfigError("key needs exactly one file, env or value source");
  const status = () => {
    try {
      if (!source) return { ok: false, missing: true, reason: "meaning search needs a TypeSafe API key: export TYPESAFE_API_KEY; nothing was sent" };
      if (source.file !== undefined) privateFile(expandHome(source.file));
      else if (!(source.value ?? env[source.env])?.trim()) throw new ConfigError("configured key source is empty");
      return { ok: true };
    } catch (error) { return { ok: false, reason: error instanceof ConfigError ? error.message : "cannot read the configured key file" }; }
  };
  return Object.freeze({
    status,
    read() {
      const state = status();
      if (!state.ok) throw new ConfigError(state.reason);
      let value;
      try { value = (source.file !== undefined ? readFileSync(expandHome(source.file), "utf8") : source.value ?? env[source.env]).trim(); }
      catch { throw new ConfigError("cannot read the configured key source"); }
      if (!value || /[\s\x00-\x1f\x7f]/.test(value)) throw new ConfigError("configured key must contain one nonempty token");
      return Object.freeze(Object.defineProperties({}, {
        authorization: { value: `Bearer ${value}` },
        fingerprint: { value: createHash("sha256").update(value).digest("hex").slice(0, 16), enumerable: true }
      }));
    }
  });
}

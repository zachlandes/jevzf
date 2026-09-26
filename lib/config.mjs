import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export class ConfigError extends Error {}

const expandHome = (value) => value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;

export function loadConfig(env = process.env) {
  const file = env.JEVZF_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "jevzf", "config.json");
  let user = {};
  try {
    user = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" || env.JEVZF_CONFIG) throw new ConfigError("cannot read config as JSON");
  }
  if (!user || typeof user !== "object" || Array.isArray(user)) throw new ConfigError("config must be an object");
  const config = {
    key_file: env.JEVZF_KEY_FILE || user.key_file || null,
    redaction_file: env.JEVZF_REDACTION_FILE || user.redaction_file || null,
    search_cap_usd: env.JEVZF_SEARCH_CAP_USD !== undefined ? Number(env.JEVZF_SEARCH_CAP_USD) : user.search_cap_usd ?? 0.02,
    daily_cap_usd: env.JEVZF_DAILY_CAP_USD !== undefined ? Number(env.JEVZF_DAILY_CAP_USD) : user.daily_cap_usd ?? 0.2,
    state_dir: env.JEVZF_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "jevzf")
  };
  for (const field of ["key_file", "redaction_file", "state_dir"]) {
    if (config[field] === null) continue;
    if (typeof config[field] !== "string" || !config[field].trim()) throw new ConfigError(`${field} must be a path`);
    config[field] = path.resolve(field === "state_dir" || env[field === "key_file" ? "JEVZF_KEY_FILE" : "JEVZF_REDACTION_FILE"] ? process.cwd() : path.dirname(file), expandHome(config[field]));
  }
  for (const field of ["search_cap_usd", "daily_cap_usd"]) {
    if (!Number.isFinite(config[field]) || config[field] < 0) throw new ConfigError(`${field} must be a nonnegative USD amount`);
  }
  return config;
}

// No default credential location or environment variable containing a key value
export function readKey(file) {
  let value;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new ConfigError("key file must be a private regular file (chmod 600)");
    value = readFileSync(file, "utf8").trim();
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("cannot read the configured key file");
  }
  if (!value || /[\r\n]/.test(value)) throw new ConfigError("key file must contain one nonempty line");
  return Object.freeze(Object.defineProperty({}, "authorization", { value: `Bearer ${value}`, enumerable: false }));
}

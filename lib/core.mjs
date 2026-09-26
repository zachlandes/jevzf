import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openJev as openGate, describeError as describeGateError, ConfigError } from "decision-gate";
import { SearchError } from "./meaning/search.mjs";

export { searchByMeaning, estimateSearch, SearchError, MAX_INPUT_BYTES } from "./meaning/search.mjs";

// jevzf's own config names only its key, so its spend stays off a key other tools share, while
// ceilings and limits stay in decision-gate's shared config
export function jevzfKeyFile(env = process.env) {
  const file = env.JEVZF_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "jevzf", "config.json");
  let config;
  try { config = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" && !env.JEVZF_CONFIG) return null;
    throw new ConfigError("cannot read jevzf config as JSON");
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some((name) => name !== "key_file")) throw new ConfigError("jevzf config holds only key_file; other settings belong in decision-gate's config");
  if (config.key_file === undefined) return null;
  if (typeof config.key_file !== "string" || !config.key_file.trim()) throw new ConfigError("key_file must be a path");
  const value = config.key_file.startsWith("~/") ? path.join(os.homedir(), config.key_file.slice(2)) : config.key_file;
  return path.resolve(path.dirname(file), value);
}

// jevzf's key file holds a TypeSafe key and goes ahead of TYPESAFE_API_KEY, which other tools
// export for their own key, so jevzf never silently spends that one; without it, or with another
// provider selected, decision-gate's defaults apply
export function openJev(options = {}) {
  const file = options.key === undefined ? jevzfKeyFile(options.env ?? process.env) : null;
  return openGate({ ...options, key: file ? { provider: "typesafe", file } : options.key, tool: "jevzf" });
}

export const describeError = (error) => error instanceof SearchError ? error.message.replace(/[\r\x1b]/g, " ") : describeGateError(error);

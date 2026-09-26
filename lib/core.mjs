import { loadConfig, readKey, ConfigError } from "./config.mjs";
import { jevEndpoint, ServiceError, SpendCapError } from "./meaning/jev.mjs";
import { createRedactor, loadRedactor, RedactionError } from "./meaning/redaction.mjs";
import { searchByMeaning, SearchError } from "./meaning/search.mjs";
import { StateError } from "./state.mjs";

// One internal owner for credentials, redaction, accounting, caching and requests
export function createSearch({ env = process.env, notice = () => {} } = {}) {
  const config = loadConfig(env);
  if (!config.key_file) {
    notice("meaning search is off; set JEVZF_KEY_FILE to enable it; passing input through (no network)");
    return Object.freeze({
      enabled: false,
      async search({ lines }) { return { lines: [...lines], passthrough: true, cached: false, spend: 0 }; }
    });
  }
  const key = readKey(config.key_file);
  const redactor = config.redaction_file ? loadRedactor(config.redaction_file) : createRedactor();
  const endpoint = jevEndpoint(env);
  return Object.freeze({
    enabled: true,
    async search({ query, lines }) {
      if (typeof query !== "string" || !Array.isArray(lines) || lines.some((line) => typeof line !== "string" || /[\r\n\0]/.test(line))) throw new ConfigError("search needs a query string and an array of individual text lines");
      if (lines.reduce((sum, line) => sum + Buffer.byteLength(line), Math.max(0, lines.length - 1)) > 10 * 1024 * 1024) throw new ConfigError("input exceeds 10 MiB; narrow the input first");
      return searchByMeaning({ query, lines, key, redactor, config, endpoint, notice });
    }
  });
}

export function describeError(error) {
  const safe = [ConfigError, ServiceError, SpendCapError, RedactionError, SearchError, StateError].some((Type) => error instanceof Type);
  return safe ? error.message.replace(/[\r\n\x1b]/g, " ") : "search failed; check file access and network connectivity (no input or key logged)";
}

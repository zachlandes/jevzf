import { amount, loadConfig, keySource, ConfigError } from "./config.mjs";
import { createResponder, createSpendBudget, jevEndpoint, ServiceError, SpendCapError, PINNED_MODEL } from "./meaning/jev.mjs";
import { createRedactor, loadRedactor, RedactionError } from "./meaning/redaction.mjs";
import { searchByMeaning, estimateSearch, assertCleanRequest, SearchError, MAX_INPUT_BYTES } from "./meaning/search.mjs";
import { clock, StateError } from "./state.mjs";
import { createLimiter } from "./limits.mjs";
import { createLedger } from "./spend.mjs";

export { searchByMeaning, estimateSearch, SearchError, MAX_INPUT_BYTES };

// Providers must have known prices and typed probabilities before they can own requests
function nativeProvider(env) {
  return { name: "typesafe", model: PINNED_MODEL, endpoint: jevEndpoint(env), respond: createResponder };
}

export function openJev(options = {}) {
  const { env = process.env, notice = () => {}, time = clock, tool = "jevzf" } = options;
  if (typeof tool !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(tool)) throw new ConfigError("tool must be a short identifier");
  const config = loadConfig(env);
  const toolPerDayUsd = options.spend?.perDayUsd === undefined ? Infinity : amount(options.spend.perDayUsd, "daily ceiling");
  const spend = {
    perSearchUsd: amount(options.spend?.perSearchUsd ?? config.spend.perSearchUsd, "per-search ceiling"),
    perDayUsd: Math.min(toolPerDayUsd, config.spend.perDayUsd)
  };
  const source = keySource(options.key, config, env);
  const neverSend = options.neverSend ?? config.never_send_file;
  const redactor = Object.freeze(neverSend ? loadRedactor(neverSend) : createRedactor());
  const provider = nativeProvider(env);
  let identity;
  const credentials = () => {
    if (!identity) {
      const key = source.read();
      identity = {
        key,
        limiter: createLimiter({ stateDir: config.stateDir, fingerprint: key.fingerprint, limits: config.limits, notice, time }),
        ledger: createLedger({ stateDir: config.stateDir, fingerprint: key.fingerprint, tool, perDayUsd: config.spend.perDayUsd, toolPerDayUsd, time })
      };
    }
    return identity;
  };
  const jev = Object.freeze({
    status: source.status,
    config: Object.freeze({ ...config, spend, provider: provider.name, model: provider.model, endpoint: provider.endpoint }),
    redactor,
    notice,
    time,
    remaining: () => credentials().ledger.remaining(),
    run({ capUsd = spend.perSearchUsd } = {}) {
      amount(capUsd, "search ceiling");
      const budgetCap = Math.min(capUsd, spend.perSearchUsd);
      let budget, lease, responder, ready, closing;
      const pending = new Set();
      const initialize = () => ready ??= (async () => {
        const { key, limiter, ledger } = credentials();
        lease = await ledger.open(budgetCap);
        budget = createSpendBudget({ capUsd: lease.capUsd });
        // The ledger reads the committed total inside its lock, so concurrent attempts never
        // persist an older total over a newer one
        const book = () => lease.book(() => budget.committedUsd());
        responder = provider.respond({ key, budget, limiter, book, assertSafe: (body) => assertCleanRequest(body, redactor), endpoint: provider.endpoint, fetchImpl: options.fetch, maxRetries: options.maxRetries });
      })().catch((error) => { ready = undefined; throw error; });
      return Object.freeze({
        ask(request, { signal } = {}) {
          if (closing) return Promise.reject(new StateError("search run is closed"));
          // Own the serialized snapshot before async work can observe caller mutations
          let snapshot;
          try {
            snapshot = JSON.stringify(request);
            assertCleanRequest(snapshot, redactor);
          } catch (error) { return Promise.reject(error); }
          const job = (async () => {
            signal?.throwIfAborted();
            await initialize();
            return responder(JSON.parse(snapshot), { signal });
          })();
          pending.add(job);
          job.then(() => pending.delete(job), () => pending.delete(job));
          return job;
        },
        // Which ceiling bounds this run: its own, or what is left of today's once the run has opened
        summary: () => ({ ...(budget?.summary() ?? { cap_usd: budgetCap, committed_usd: 0, billed_input_tokens: 0, attempts_booked_at_reservation: 0 }), ceiling: lease && lease.capUsd < budgetCap ? "day" : "search" }),
        close() {
          // Closing waits for asks already made, so the ledger records their final cost
          closing ??= (async () => {
            await Promise.allSettled([...pending]);
            if (lease) await lease.close(budget.committedUsd());
          })();
          return closing;
        }
      });
    }
  });
  return jev;
}

export function describeError(error) {
  const safe = [ConfigError, ServiceError, SpendCapError, RedactionError, SearchError, StateError].some((Type) => error instanceof Type);
  return safe ? error.message.replace(/[\r\x1b]/g, " ") : "search failed; check file access and network connectivity (no input or key logged)";
}

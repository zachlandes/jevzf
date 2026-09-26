import { readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StateError } from "./errors.mjs";
import { clock, dead, locked, readJson, writeJson } from "./state.mjs";

// The SDK gives up on an attempt after 30 seconds, so a slot held twice that long belongs to a
// process that stopped without releasing it
const SLOT_MS = 60000;
// Another process frees a slot without telling this one, so a waiter looks again this often
const POLL_MS = 50;

const localWindows = new Map();
const mine = new Set();
const swept = new Set();

// Windows used to be filed per key fingerprint. They hold at most a minute of starts and a pause,
// so they are dropped rather than merged into the account's window
function dropKeyWindows(dir) {
  if (swept.has(dir)) return;
  swept.add(dir);
  try {
    for (const name of readdirSync(dir)) if (/^[0-9a-f]{16}\.json$/.test(name)) rmSync(path.join(dir, name), { force: true });
  } catch { /* A leftover window only wastes a little disk */ }
}

const valid = (state) => Array.isArray(state.starts) && Number.isFinite(state.pausedUntil) && Array.isArray(state.inFlight)
  && state.starts.every((e) => Number.isFinite(e.at) && Number.isFinite(e.tokens) && e.tokens >= 0)
  && state.inFlight.every((e) => Number.isFinite(e.at) && typeof e.token === "string" && typeof e.host === "string" && Number.isInteger(e.pid));

// The service counts rate limits per account, not per key, so every key on one account shares
// one window, one pause and one set of in-flight slots
export function createLimiter({ dir, account, limits, notice = () => {}, time = clock }) {
  const file = path.join(dir, "accounts", `${account}.json`);
  const rpm = Math.floor(limits.requestsPerMinute * limits.share);
  const tps = Math.floor(limits.tokensPerSecond * limits.share);
  let local = false;
  const transaction = async (job, signal) => {
    if (!local) {
      try {
        dropKeyWindows(dir);
        return await locked(file, () => {
          const state = readJson(file, { starts: [], pausedUntil: 0, inFlight: [] });
          if (!valid(state)) throw new StateError("invalid rate-limit state");
          const result = job(state);
          writeJson(file, state);
          return result;
        }, { signal, time });
      } catch (error) {
        if (!["EACCES", "EPERM", "EROFS", "ENOSPC", "ENOTDIR"].includes(error.code)) throw error;
        local = true;
        notice("shared rate-limit state is unwritable; using in-process limits (spend ceilings still apply)");
      }
    }
    if (!localWindows.has(file)) localWindows.set(file, { starts: [], pausedUntil: 0, inFlight: [] });
    return job(localWindows.get(file));
  };
  return {
    // Takes a rate slot for one attempt of `tokens` counted tokens; `estimated` is its likely real
    // size, which decides whether it is a large request. Resolves to the slot, released once the
    // attempt has its answer
    async take(tokens, { estimated = tokens, signal } = {}) {
      if (rpm < 1 || tokens > tps) throw new StateError("configured rate limits cannot fit one reserved request; increase DECISION_GATE_RPM or DECISION_GATE_TPS");
      const large = estimated >= limits.largeRequestTokens;
      const slot = { token: randomUUID(), host: os.hostname(), pid: process.pid, large };
      for (;;) {
        signal?.throwIfAborted();
        const wait = await transaction((state) => {
          const now = time.now();
          state.starts = state.starts.filter((e) => e.at > now - 60000);
          state.inFlight = state.inFlight.filter((e) => e.at > now - SLOT_MS && !dead(e, mine));
          if (state.pausedUntil > now) return state.pausedUntil - now;
          let until = now;
          if (state.starts.length >= rpm) until = Math.max(until, state.starts[state.starts.length - rpm].at + 60000);
          const recent = state.starts.filter((e) => e.at > now - 1000);
          let total = recent.reduce((sum, e) => sum + e.tokens, tokens);
          for (const entry of recent) {
            if (total <= tps) break;
            total -= entry.tokens;
            until = Math.max(until, entry.at + 1000);
          }
          if (until > now) return until - now;
          if (state.inFlight.length >= limits.inFlight || (large && state.inFlight.filter((e) => e.large).length >= limits.largeInFlight)) return POLL_MS;
          state.starts.push({ at: now, tokens });
          state.inFlight.push({ ...slot, at: now });
          mine.add(slot.token);
          return 0;
        }, signal);
        if (!wait) break;
        await time.sleep(wait, signal);
      }
      let released;
      return {
        release() {
          released ??= transaction((state) => { state.inFlight = state.inFlight.filter((e) => e.token !== slot.token); })
            // A slot that cannot be released expires on its own, so the answer is not lost to it
            .catch(() => {})
            .finally(() => mine.delete(slot.token));
          return released;
        }
      };
    },
    async pause(ms) {
      await transaction((state) => { state.pausedUntil = Math.max(state.pausedUntil, time.now() + ms); });
    }
  };
}

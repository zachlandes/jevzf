import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class StateError extends Error {}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new StateError("cannot read local state; refusing to spend");
  }
}

// Persist a reservation before the request; a killed process leaves it booked
function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    const dir = openSync(path.dirname(file), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

export async function withState(dir, job, { lockTimeoutMs = 35000 } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lock = path.join(dir, "search.lock");
  const start = Date.now();
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - start >= lockTimeoutMs) throw new StateError("state is locked by another search; see README for interrupted-search recovery");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    const spendFile = path.join(dir, "spend.json");
    const cacheFile = path.join(dir, "cache.json");
    const spend = readJson(spendFile, []);
    if (!Array.isArray(spend) || spend.some((e) => !Number.isFinite(e?.at) || !Number.isFinite(e?.usd) || e.usd < 0)) throw new StateError("invalid spend ledger; refusing to spend");
    const recent = spend.filter((e) => e.at >= Date.now() - 86400000);
    const cache = readJson(cacheFile, []);
    if (!Array.isArray(cache)) throw new StateError("invalid result cache");
    const run = { at: Date.now(), usd: 0 };
    return await job({
      spent: recent.reduce((sum, e) => sum + e.usd, 0),
      book(usd) {
        run.at = Date.now();
        run.usd = usd;
        writeJson(spendFile, [...recent, run]);
      },
      get(key) { return cache.find((e) => e.key === key)?.scores; },
      put(key, scores) {
        writeJson(cacheFile, [{ key, scores }, ...cache.filter((e) => e.key !== key)].slice(0, 100));
      }
    });
  } finally {
    rmSync(lock, { recursive: true });
  }
}

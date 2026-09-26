import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
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

// A damaged cache costs only repeat searches, so it is dropped rather than blocking them
function readCache(file, notice) {
  try {
    const cache = JSON.parse(readFileSync(file, "utf8"));
    const valid = (e) => typeof e?.key === "string" && Array.isArray(e.scores) && e.scores.every((p) => Number.isFinite(p) && p >= 0 && p <= 1);
    if (Array.isArray(cache) && cache.every(valid)) return cache;
  } catch (error) {
    if (error.code === "ENOENT") return [];
  }
  rmSync(file, { force: true });
  notice("result cache was unreadable; discarded it");
  return [];
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

const heldLocks = new Set();

function lockOwner(lock) {
  try { return readFileSync(path.join(lock, "owner"), "utf8"); }
  catch { return null; }
}

function ownerExited(owner) {
  const pid = Number(owner.split(":")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  // A container restart can reuse a killed owner's pid for this process
  if (pid === process.pid) return !heldLocks.has(owner);
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

// The lock directory appears with its owner already inside, so no one ever sees an ownerless lock
function tryLock(lock) {
  const owner = `${process.pid}:${randomUUID()}`;
  const temp = `${lock}.${randomUUID()}.tmp`;
  try {
    mkdirSync(temp, { mode: 0o700 });
    writeFileSync(path.join(temp, "owner"), owner);
    renameSync(temp, lock);
    heldLocks.add(owner);
    return owner;
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") return null;
    throw error;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Moving the lock aside first means a half-removed lock is never an empty directory that another
// process's rename could replace
function discardLock(lock) {
  const trash = `${lock}.${randomUUID()}.old`;
  renameSync(lock, trash);
  rmSync(trash, { recursive: true, force: true });
}

// Breakers take a guard so two of them cannot both judge the same dead owner and then remove a
// lock the first one's successor has since taken
function breakStaleLock(lock) {
  const guard = `${lock}.guard`;
  try { mkdirSync(guard, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    // The guard is held only for a few synchronous calls, so an old one was left by a killed process
    try { if (Date.now() - statSync(guard).mtimeMs > 10000) rmdirSync(guard); } catch { /* another breaker got there */ }
    return;
  }
  try {
    const owner = lockOwner(lock);
    if (owner !== null && ownerExited(owner)) discardLock(lock);
  } finally {
    rmdirSync(guard);
  }
}

export async function withState(dir, job, { lockTimeoutMs = 35000, notice = () => {} } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lock = path.join(dir, "search.lock");
  const start = Date.now();
  let owner;
  while (!(owner = tryLock(lock))) {
    breakStaleLock(lock);
    if (Date.now() - start >= lockTimeoutMs) throw new StateError("state is locked by another running search");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    const spendFile = path.join(dir, "spend.json");
    const cacheFile = path.join(dir, "cache.json");
    const spend = readJson(spendFile, []);
    if (!Array.isArray(spend) || spend.some((e) => !Number.isFinite(e?.at) || !Number.isFinite(e?.usd) || e.usd < 0)) throw new StateError("invalid spend ledger; refusing to spend");
    const recent = spend.filter((e) => e.at >= Date.now() - 86400000);
    const cache = readCache(cacheFile, notice);
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
    heldLocks.delete(owner);
    discardLock(lock);
  }
}

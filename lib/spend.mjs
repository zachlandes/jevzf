import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendRecord, clock, locked, replaceFile, StateError } from "./state.mjs";
import { SpendCapError } from "./meaning/jev.mjs";

const HOLD_MS = 10 * 60000;
const day = (now) => new Date(now).toISOString().slice(0, 10);

function records(file, now) {
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return new Map(); throw error; }
  const latest = new Map();
  const lines = text.split("\n").filter(Boolean);
  try {
    for (const line of lines) {
      const row = JSON.parse(line);
      if (typeof row.id !== "string" || typeof row.tool !== "string" || typeof row.day !== "string" || !Number.isFinite(row.at) || !Number.isFinite(row.usd) || row.usd < 0 || !Number.isFinite(row.hold) || row.hold < row.usd || typeof row.closed !== "boolean") throw new Error();
      latest.set(row.id, row);
    }
  } catch { throw new StateError("invalid spend ledger; refusing to spend"); }
  // Only today's rows count and only yesterday's runs may still close, so compact the rest away
  // rather than re-reading every past search under the lock
  const live = new Set([day(now), day(now - 86400000)]);
  const kept = [...latest.values()].filter((row) => live.has(row.day));
  if (lines.length - kept.length > Math.max(256, kept.length)) {
    replaceFile(file, kept.map((row) => `${JSON.stringify(row)}\n`).join(""));
    return new Map(kept.map((row) => [row.id, row]));
  }
  return latest;
}

function used(rows, tool, today, now, except) {
  return [...rows.values()].filter((r) => r.tool === tool && r.day === today && r.id !== except).reduce((sum, r) => sum + (!r.closed && now - r.at < HOLD_MS ? r.hold : r.usd), 0);
}

export function createLedger({ stateDir, fingerprint, tool, perDayUsd, time = clock }) {
  const file = path.join(stateDir, "spend", `${fingerprint}.jsonl`);
  return {
    remaining() {
      return locked(file, () => Math.max(0, perDayUsd - used(records(file, time.now()), tool, day(time.now()), time.now())), { time });
    },
    async open(capUsd, signal) {
      let row;
      await locked(file, () => {
        const now = time.now();
        const available = Math.max(0, perDayUsd - used(records(file, now), tool, day(now), now));
        row = { id: randomUUID(), tool, day: day(now), at: now, usd: 0, hold: Math.min(capUsd, available), closed: false };
        appendRecord(file, row);
      }, { signal, time });
      const update = (total, closed = false) => locked(file, () => {
        const usd = typeof total === "function" ? total() : total;
        const now = time.now();
        const rows = records(file, now);
        if (row.closed) throw new StateError("search run is closed");
        // A renewed lease or midnight boundary must re-check other processes' holds
        if (!closed && (day(now) !== row.day || now - row.at >= HOLD_MS)) {
          if (day(now) !== row.day) throw new SpendCapError("UTC day changed; start a new search");
          const available = perDayUsd - used(rows, tool, row.day, now, row.id);
          row.hold = Math.min(row.hold, Math.max(row.usd, available));
        }
        if (!closed && usd > row.hold + 1e-12) throw new SpendCapError("daily spend ceiling reached");
        row = { ...row, at: now, usd, hold: closed ? usd : Math.max(usd, row.hold), closed };
        appendRecord(file, row);
      }, { time });
      return { capUsd: row.hold, book: (usd) => update(usd), close: (usd) => update(usd, true) };
    }
  };
}

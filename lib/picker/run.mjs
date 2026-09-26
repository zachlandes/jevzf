import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { endFile, fzfArgs, inputFile, saveState } from "./keys.mjs";

export class PickerError extends Error {}

// Unix-socket --listen arrived in fzf 0.66.0; everything else the picker binds is older
export const FZF_MIN = [0, 66, 0];
const INSTALL = "install it with brew install fzf, or use the filter: cmd | jevzf QUERY";

export function findFzf(env = process.env) {
  const probe = spawnSync("fzf", ["--version"], { encoding: "utf8", env });
  if (probe.error || probe.status !== 0) throw new PickerError(`the picker needs fzf 0.66 or newer, and none was found; ${INSTALL}`);
  const version = probe.stdout.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const differs = version?.findIndex((part, i) => part !== FZF_MIN[i]) ?? 0;
  if (!version || (differs >= 0 && version[differs] < FZF_MIN[differs])) throw new PickerError(`the picker needs fzf 0.66 or newer, found ${version ? version.join(".") : "an unknown version"}; ${INSTALL}`);
}

// fzf's default header colour is a fixed grey-blue that fades on light themes, so the header uses
// the terminal's own foreground. It goes ahead of the user's fzf defaults, which fzf reads from
// FZF_DEFAULT_OPTS_FILE and then FZF_DEFAULT_OPTS, so a colour they chose still wins
export function fzfEnv(env, dir) {
  const ours = "--color=header:-1";
  if (!env.FZF_DEFAULT_OPTS_FILE) return { ...env, FZF_DEFAULT_OPTS: `${ours} ${env.FZF_DEFAULT_OPTS ?? ""}`.trim() };
  let theirs;
  try { theirs = readFileSync(env.FZF_DEFAULT_OPTS_FILE, "utf8"); }
  catch { return env; }
  const file = path.join(dir, "fzf-opts");
  writeFileSync(file, `${ours}\n${theirs}`, { mode: 0o600 });
  return { ...env, FZF_DEFAULT_OPTS_FILE: file };
}

// macOS refuses Unix sockets whose path passes 104 bytes, and TMPDIR can be long
function runDir() {
  const base = path.join(os.tmpdir(), "jz.").length <= 60 ? os.tmpdir() : "/tmp";
  return mkdtempSync(path.join(base, "jz."));
}

export async function runPicker({ options, env = process.env, stdin = process.stdin }) {
  findFzf(env);
  const dir = runDir();
  try {
    saveState(dir, { mode: "fuzzy", phase: "ask", words: "", gen: 0, summary: null, progress: null, options });
    const copy = openSync(inputFile(dir), "wx", 0o600);
    // fzf lists the private copy rather than reading stdin itself: a reload waits for fzf's read of
    // stdin to return, which a slow producer can hold up indefinitely
    const child = spawn("fzf", fzfArgs(dir, options), { stdio: ["ignore", "inherit", "inherit"], env: { ...fzfEnv(env, dir), JEVZF_PICKER_DIR: dir } });
    const forward = (signal) => child.kill(signal);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, forward);
    stdin.on("data", (chunk) => writeSync(copy, chunk));
    stdin.on("end", () => writeFileSync(endFile(dir), "", { mode: 0o600 }));
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status, signal) => resolve(status ?? (signal ? 130 : 2)));
    });
    stdin.destroy();
    closeSync(copy);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, forward);
    return code;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

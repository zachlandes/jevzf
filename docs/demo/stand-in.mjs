// Runs a shell snippet against a loopback stand-in for TypeSafe, for the demo documents in this
// folder. The stand-in answers Jev's relevance questions by keyword, so the demo needs no key,
// sends nothing to the network and spends nothing. Each run gets fresh state, cache and config.
//
//   node stand-in.mjs 'snippet'
//
// The snippet runs `jevzf` from this checkout, and sees SENT (a file of every line the stand-in
// received, one per line) and ARRIVED (a file that appears when a request arrives). A search whose
// words start with "stuck" is never answered, so a snippet can interrupt it mid-request.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const snippet = process.argv.at(-1);
const cli = fileURLToPath(new URL("../../bin/jevzf.mjs", import.meta.url));
const home = mkdtempSync(path.join(tmpdir(), "jevzf-demo-"));
const sent = path.join(home, "sent"), arrived = path.join(home, "arrived");
writeFileSync(sent, "");
const bin = path.join(home, "bin");
mkdirSync(bin);
writeFileSync(path.join(bin, "jevzf"), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`);
chmodSync(path.join(bin, "jevzf"), 0o755);
const score = (text) => /retry|back ?off|429|529/i.test(text) ? 0.93 : /timeout|rate.limit/i.test(text) ? 0.71 : 0.04;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const { search, items } = JSON.parse(body).state;
  for (const text of Object.values(items)) appendFileSync(sent, `${text}\n`);
  writeFileSync(arrived, "");
  if (search.startsWith("stuck")) return;
  res.setHeader("content-type", "application/json");
  // About what a live request over a dozen short lines reported (2,723 tokens), so ceilings bind
  // as they would for real
  res.end(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 2800 }, answers: Object.fromEntries(Object.entries(items).map(([id, text]) => [id, { type: "noul", noul: score(text) }])) }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const child = spawn("sh", ["-c", snippet], {
  stdio: "inherit",
  env: {
    PATH: `${bin}:${process.env.PATH}`, HOME: home, LANG: "en_US.UTF-8",
    XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home,
    TYPESAFE_API_KEY: "stand-in-not-a-real-key",
    JEVZF_JEV_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/systemone`,
    SENT: sent, ARRIVED: arrived
  }
});
const code = await new Promise((resolve) => child.on("close", resolve));
server.closeAllConnections();
server.close();
rmSync(home, { recursive: true, force: true });
process.exitCode = code;

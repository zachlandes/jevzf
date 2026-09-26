import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { blank, recompress } from "../scripts/png.mjs";

// A minimal RGBA PNG whose pixels come from fill(x, y), stored with fast compression like screencapture
function png(width, height, fill) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) row.set(fill(x, y), 1 + x * 4);
    rows.push(row);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

const pixels = (file) => {
  const data = readFileSync(file);
  const parts = [];
  for (let at = 8; at < data.length;) {
    const size = data.readUInt32BE(at);
    if (data.toString("ascii", at + 4, at + 8) === "IDAT") parts.push(data.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  return inflateSync(Buffer.concat(parts));
};

test("a uniform capture counts as blank and a varied one does not; recompression keeps every pixel", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "jevzf-png-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const empty = path.join(dir, "empty.png"), shot = path.join(dir, "shot.png");
  writeFileSync(empty, png(64, 64, () => [0, 0, 0, 0]));
  // Text-like stripes plus a gradient, so every byte value appears as in a real screenshot
  writeFileSync(shot, png(256, 64, (x, y) => (y % 8 < 2 ? [x, 255 - x, (x * y) & 255, 255] : [30, 30, 30, 255])));
  assert.equal(blank(empty), true);
  assert.equal(blank(shot), false);
  const before = pixels(shot), size = readFileSync(shot).length;
  recompress(shot);
  assert.ok(pixels(shot).equals(before));
  assert.ok(readFileSync(shot).length <= size);
  assert.equal(blank(shot), false);
});

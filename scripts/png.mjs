// PNG checks for the legibility screenshots, kept apart from the script so they can be tested
// without anything that could open a window
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync, inflateSync } from "node:zlib";

// A capture of the wrong or an undrawn window decodes to one repeated byte; a real terminal
// screenshot holds all 256
export function blank(file) {
  const png = readFileSync(file);
  const parts = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") parts.push(png.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  return new Set(inflateSync(Buffer.concat(parts))).size < 16;
}

// screencapture writes fast, loose compression; the same scanlines at zlib level 9 are about a
// fifth smaller with identical pixels, which matters for evidence committed to the repo
export function recompress(file) {
  const png = readFileSync(file);
  const chunks = [], idat = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at), type = png.toString("ascii", at + 4, at + 8), data = png.subarray(at + 8, at + 8 + size);
    if (type !== "IDAT") chunks.push([type, data]);
    else { if (!idat.length) chunks.push(["IDAT", null]); idat.push(data); }
    at += 12 + size;
  }
  const packed = deflateSync(inflateSync(Buffer.concat(idat)), { level: 9 });
  const out = [png.subarray(0, 8)];
  for (const [type, original] of chunks) {
    const data = original ?? packed;
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    out.push(head, data, crc);
  }
  const result = Buffer.concat(out);
  if (result.length < png.length) writeFileSync(file, result);
}

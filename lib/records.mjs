// Records keep their original bytes and terminator; only matching receives decoded text
export function splitRecords(input, delimiter) {
  const records = [];
  for (let start = 0; start < input.length;) {
    const end = input.indexOf(delimiter, start);
    const stop = end < 0 ? input.length : end;
    const bytes = input.subarray(start, stop);
    records.push({ text: bytes.toString("utf8"), bytes, terminated: end >= 0 });
    start = end < 0 ? input.length : end + 1;
  }
  return records;
}

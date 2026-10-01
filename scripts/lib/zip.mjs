// Reading and writing .xpi files, which are ZIP archives, with nothing but
// Node's zlib. The checks never unpack an archive to disk: entries are read
// into memory one at a time, so a hostile file name cannot write anywhere, and
// every read is capped, so a small archive that inflates to gigabytes (a "zip
// bomb") stops at the cap instead of filling memory.
import zlib from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

/** Ceilings for what one archive may inflate to. */
const DEFAULT_LIMITS = {
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class ZipError extends Error {}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A name that could reach outside the folder it is unpacked into, or mean different things to different readers. */
function unsafeName(name) {
  return (
    name === "" ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").includes("..")
  );
}

/**
 * Opens an archive held in a Buffer. Returns the entry names and a `read`
 * that inflates one entry and checks its CRC.
 *
 * ZIP64 and encrypted entries are refused: a plugin has no use for either,
 * and refusing them keeps the reader small.
 *
 * What is checked must be what Paperly runs, so anything Gecko's own reader
 * (nsZipArchive) would read differently is refused rather than guessed at.
 * Gecko ignores the entry count and walks the directory until the end record,
 * and of two entries with the same name it uses the last; so the directory
 * here must end exactly at the end record, and every name must be unique.
 */
export function readZip(buffer, limits = {}) {
  const { maxEntryBytes, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new ZipError("Not a ZIP archive");
  }
  // A directory record at byte 4 is Gecko's "optimized jar" layout, in which
  // it skips the end record and reads a directory of its own choosing.
  if (buffer.readUInt32LE(4) === CENTRAL) {
    throw new ZipError("The archive uses a layout that Paperly would read differently");
  }

  // The end-of-central-directory record is the last thing in the file, after
  // a comment of up to 65535 bytes.
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new ZipError("Not a ZIP archive");
  }
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError("ZIP64 archives are not supported");
  }
  if (cdOffset + cdSize > eocd) {
    throw new ZipError("The archive's directory is damaged");
  }

  const entries = new Map();
  const seen = new Set();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buffer.readUInt32LE(p) !== CENTRAL) {
      throw new ZipError("The archive's directory is damaged");
    }
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const offset = buffer.readUInt32LE(p + 42);
    const rawName = buffer.subarray(p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    if (p > eocd) {
      throw new ZipError("The archive's directory is damaged");
    }

    // Gecko compares names as bytes. Decoding with replacement characters
    // would let two different names become one here, and only one be checked.
    let name;
    try {
      name = UTF8.decode(rawName);
    } catch {
      throw new ZipError("A file name in the archive is not valid UTF-8");
    }
    const key = rawName.toString("latin1");
    if (seen.has(key)) {
      throw new ZipError(`${name} is in the archive twice`);
    }
    seen.add(key);
    if (unsafeName(name)) {
      throw new ZipError(`${JSON.stringify(name)} is not a safe file name`);
    }
    if (flags & 1) {
      throw new ZipError(`${name} is encrypted`);
    }
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) {
      throw new ZipError("ZIP64 archives are not supported");
    }
    // Tools that read the local headers instead of the directory must see
    // the same names.
    if (
      offset + 30 > buffer.length ||
      buffer.readUInt32LE(offset) !== LOCAL ||
      buffer.readUInt16LE(offset + 26) !== nameLength ||
      offset + 30 + nameLength > buffer.length ||
      !buffer.subarray(offset + 30, offset + 30 + nameLength).equals(rawName)
    ) {
      throw new ZipError(`${name} has a different name, or none, in its local header`);
    }
    if (name.endsWith("/")) {
      continue;
    }
    entries.set(name, { name, method, crc, compressedSize, size, offset });
  }
  if (p !== cdOffset + cdSize || p !== eocd) {
    throw new ZipError("The archive's directory holds more than its end record says");
  }

  let total = 0;
  function read(name) {
    const entry = entries.get(name);
    if (!entry) {
      return null;
    }
    if (entry.size > maxEntryBytes) {
      throw new ZipError(`${name} is too large to check (${entry.size} bytes)`);
    }
    // Counted before inflating, from the size the directory states (which the
    // inflated data must then match), so the cap bounds the work as well as
    // the memory.
    if (total + entry.size > maxTotalBytes) {
      throw new ZipError("The archive inflates to more than can be checked");
    }
    total += entry.size;
    const o = entry.offset;
    if (o + 30 > buffer.length || buffer.readUInt32LE(o) !== LOCAL) {
      throw new ZipError(`${name} is damaged`);
    }
    // The local header's own name and extra lengths can differ from the
    // central directory's; only the local ones say where the data starts.
    const start = o + 30 + buffer.readUInt16LE(o + 26) + buffer.readUInt16LE(o + 28);
    const end = start + entry.compressedSize;
    if (end > buffer.length) {
      throw new ZipError(`${name} is damaged`);
    }
    const raw = buffer.subarray(start, end);
    let data;
    if (entry.method === STORED) {
      data = Buffer.from(raw);
    } else if (entry.method === DEFLATED) {
      try {
        // One byte over the stated size is enough to tell a lie from the truth.
        data = zlib.inflateRawSync(raw, { maxOutputLength: entry.size + 1 });
      } catch {
        throw new ZipError(`${name} is damaged or larger than it says`);
      }
    } else {
      throw new ZipError(`${name} uses an unsupported compression method (${entry.method})`);
    }
    if (data.length !== entry.size || crc32(data) !== entry.crc) {
      throw new ZipError(`${name} is damaged (its checksum does not match)`);
    }
    return data;
  }

  return { names: [...entries.keys()], entries, read };
}

/**
 * Writes an archive from `[{ name, data }]`. Timestamps are fixed, so the same
 * files always make the same bytes -- and so the same hash. A name may be a
 * Buffer, for tests that need bytes no string would give.
 */
export function writeZip(files, { compress = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // 1980-01-01 00:00, the earliest time a ZIP can hold.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;

  for (const file of files) {
    const name = Buffer.isBuffer(file.name) ? file.name : Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const deflated = compress ? zlib.deflateRawSync(data, { level: 9 }) : null;
    const useDeflate = deflated !== null && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? DEFLATED : STORED;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

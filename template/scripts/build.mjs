#!/usr/bin/env node
// Packs src/ into dist/<id>-<version>.xpi: the file to attach to a GitHub
// release. Needs Node 20 or later and nothing else.
//
//   node scripts/build.mjs
//
// It refuses to build what the Paperly marketplace would refuse -- no id, no
// version bounds, no bootstrap.js, or an update_url that does not point at the
// marketplace -- so a mistake shows up here rather than in a pull request.
//
//   PAPERLY_MARKETPLACE=http://127.0.0.1:8765/ node scripts/build.mjs
//
// builds for a local test marketplace instead: src/manifest.json stays as it
// is, and the packed copy's update_url points at that address. Such an .xpi is
// for testing only; the marketplace refuses it.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

export const MARKETPLACE = "https://quynhtl.github.io/paperly-extensions/";

/** The id as it appears in the marketplace's file names and URLs. */
export function slug(id) {
  return String(id).replace(/[^A-Za-z0-9._@-]/g, "_");
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP of [{ name, data }], with fixed timestamps so the same files make the same bytes. */
function zip(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const header = (signature, size) => {
      const b = Buffer.alloc(size);
      b.writeUInt32LE(signature, 0);
      return b;
    };
    const local = header(0x04034b50, 30);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(33, 12); // 1980-01-01
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, body);

    const central = header(0x02014b50, 46);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const cd = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

function listFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      files.push(...listFiles(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

/**
 * Reads src/ and returns the .xpi's name and bytes, or throws with every
 * problem found. `warnings` are things to fix before publishing.
 * `marketplace`, when given, is a test marketplace the packed manifest's
 * update_url points at instead of the real one.
 */
export function buildXpi(srcDir, { marketplace } = {}) {
  const problems = [];
  const warnings = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(srcDir, "manifest.json"), "utf8"));
  } catch (e) {
    throw new Error(`src/manifest.json cannot be read: ${e.message}`);
  }
  const zotero = manifest.applications?.zotero || {};
  if (manifest.manifest_version !== 2) problems.push('"manifest_version" must be 2.');
  if (!manifest.name) problems.push('"name" is missing.');
  const version = String(manifest.version || "");
  if (version.length > 64 || /\d{10}/.test(version) || !/^\d+(?:\.\d+){0,3}(?:[a-z][a-z0-9.+-]*)?$/i.test(version)) {
    problems.push(`"version" must look like 1.2.3 (up to 64 characters, no number over 9 digits), not "${manifest.version}".`);
  }
  if (!zotero.id) problems.push('"applications.zotero.id" is missing.');
  if (!zotero.strict_min_version || !zotero.strict_max_version) {
    problems.push('"applications.zotero" needs "strict_min_version" and "strict_max_version".');
  }
  const updateURL = `${MARKETPLACE}updates/${slug(zotero.id)}.json`;
  if (zotero.id && zotero.update_url !== updateURL) {
    problems.push(`"applications.zotero.update_url" must be ${updateURL}`);
  }
  if (/@(?:your-login\.github\.io|example\.com)$/i.test(zotero.id ?? "")) {
    warnings.push(
      `The id is still ${zotero.id}. Choose your own, such as name@<your GitHub login>.github.io, before you publish: it can never change afterwards.`,
    );
  }
  const files = listFiles(srcDir).map((path) => ({
    name: relative(srcDir, path).split(sep).join("/"),
    data: readFileSync(path),
  }));
  if (!files.some((f) => f.name === "bootstrap.js")) problems.push("src/bootstrap.js is missing.");
  for (const icon of Object.values(manifest.icons || {})) {
    if (!files.some((f) => f.name === icon.replace(/^\.?\//, ""))) problems.push(`The icon ${icon} is not in src/.`);
  }
  if (problems.length) {
    throw new Error(problems.join("\n"));
  }
  if (marketplace && marketplace !== MARKETPLACE) {
    const packed = structuredClone(manifest);
    packed.applications.zotero.update_url = `${marketplace}updates/${slug(zotero.id)}.json`;
    files.find((f) => f.name === "manifest.json").data = Buffer.from(`${JSON.stringify(packed, null, 2)}\n`);
    warnings.push(`Built for the test marketplace at ${marketplace}. Do not release this .xpi; the marketplace refuses it.`);
  }
  return { name: `${slug(zotero.id)}-${manifest.version}.xpi`, data: zip(files), manifest, warnings };
}

/** $PAPERLY_MARKETPLACE as a base URL ending in "/", or undefined. */
function testMarketplace(value) {
  if (!value) {
    return undefined;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (!url || !/^https?:$/.test(url.protocol)) {
    throw new Error(`PAPERLY_MARKETPLACE must be an http:// or https:// address, not "${value}".`);
  }
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  try {
    const marketplace = testMarketplace(process.env.PAPERLY_MARKETPLACE);
    const { name, data, warnings } = buildXpi(join(root, "src"), { marketplace });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", name), data);
    for (const warning of warnings) {
      console.warn(`warning: ${warning}`);
    }
    console.log(`dist/${name} (${data.length} bytes)`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

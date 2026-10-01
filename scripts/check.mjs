#!/usr/bin/env node
// Checks listings, and optionally a built .xpi against its listing, the way
// the marketplace will. Run it before opening a pull request:
//
//   node scripts/check.mjs                                  every listing
//   node scripts/check.mjs extensions/my-ext@me.org.json    one listing
//   node scripts/check.mjs extensions/my-ext@me.org.json --xpi build/my-ext.xpi
//
// Exits 1 if anything would keep the listing or the version out.
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, loadConfig } from "./lib/config.mjs";
import { validateListing } from "./lib/listing.mjs";
import { inspectXpi } from "./lib/inspect.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { xpi: { type: "string" } },
});

const config = loadConfig();
const files = positionals.length
  ? positionals
  : readdirSync(join(ROOT, "extensions"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(ROOT, "extensions", f));
if (values.xpi && files.length !== 1) {
  console.error("--xpi checks one .xpi against one listing; name the listing.");
  process.exit(2);
}

let failed = false;
const ids = new Map();
for (const file of files) {
  console.log(file);
  let listing;
  try {
    listing = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.log(`  error   The listing is not valid JSON: ${e.message}`);
    failed = true;
    continue;
  }
  const errors = validateListing(listing, { fileName: basename(file) });
  if (ids.has(listing.id)) {
    errors.push(`${ids.get(listing.id)} already lists "${listing.id}".`);
  }
  ids.set(listing.id, file);
  for (const message of errors) {
    console.log(`  error   ${message}`);
  }
  failed ||= errors.length > 0;
  if (!errors.length) {
    console.log("  listing ok");
  }

  if (values.xpi && !errors.length) {
    const result = inspectXpi(readFileSync(values.xpi), { listing, config });
    console.log(`  ${basename(values.xpi)}: version ${result.version ?? "?"}`);
    for (const f of result.findings) {
      console.log(`    ${f.level.padEnd(7)} ${f.message}`);
    }
    if (result.detected.uses.length) {
      console.log(`    uses    ${result.detected.uses.join(", ")}`);
    }
    console.log(`    ${result.ok ? "passes" : "would be rejected"}`);
    failed ||= !result.ok;
  }
}
process.exit(failed ? 1 : 0);

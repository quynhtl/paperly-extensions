#!/usr/bin/env node
// Builds the published marketplace (see scripts/lib/build.mjs) into a folder,
// ready to be served as it is.
//
//   node scripts/build.mjs --out dist
//       Every listing, from its GitHub releases. Signs with the private key in
//       $REGISTRY_SIGNING_KEY, or the file given with --key-file. Set
//       $GITHUB_TOKEN to avoid GitHub's limit on anonymous requests.
//
//   node scripts/build.mjs --out dist --base-url http://127.0.0.1:8765/ \
//       --key-file dev.key --local hello@example.com=build/hello.xpi
//       A local marketplace for testing: only the listings given a local
//       .xpi with --local are built, and the addresses point at --base-url.
//
// --unsigned builds without a signature; Paperly will refuse such an index.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, loadConfig } from "./lib/config.mjs";
import { buildRegistry, validateBlocked } from "./lib/build.mjs";
import { download, listReleases } from "./lib/github.mjs";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: join(ROOT, "dist") },
    "base-url": { type: "string" },
    "key-file": { type: "string" },
    unsigned: { type: "boolean", default: false },
    local: { type: "string", multiple: true, default: [] },
  },
});

const config = loadConfig();
if (values["base-url"]) {
  config.baseURL = values["base-url"].endsWith("/") ? values["base-url"] : `${values["base-url"]}/`;
}

const signingKey = values["key-file"]
  ? readFileSync(values["key-file"], "utf8").trim()
  : process.env.REGISTRY_SIGNING_KEY?.trim();
if (!signingKey && !values.unsigned) {
  console.error("No signing key: set REGISTRY_SIGNING_KEY, pass --key-file, or build --unsigned.");
  process.exit(2);
}

const blockedFile = JSON.parse(readFileSync(join(ROOT, "blocked.json"), "utf8"));
const blockedErrors = validateBlocked(blockedFile);
if (blockedErrors.length) {
  console.error(blockedErrors.join("\n"));
  process.exit(1);
}
// Looked up by extension id, which is anyone's choice: with no prototype, no
// id can find an inherited member instead of a block.
const blocked = Object.assign(Object.create(null), blockedFile);

const local = new Map(
  values.local.map((pair) => {
    const at = pair.lastIndexOf("=");
    return [pair.slice(0, at), pair.slice(at + 1)];
  }),
);

const listings = [];
for (const name of readdirSync(join(ROOT, "extensions")).filter((f) => f.endsWith(".json")).sort()) {
  const file = join(ROOT, "extensions", name);
  let listing = null;
  try {
    listing = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // validateListing reports it.
  }
  if (local.size && !local.has(listing?.id)) {
    continue;
  }
  listings.push({ file, listing });
}

async function candidates(listing) {
  if (local.has(listing.id)) {
    const path = local.get(listing.id);
    return [
      {
        label: path,
        released: statSync(path).mtime.toISOString(),
        load: async () => readFileSync(path),
      },
    ];
  }
  const releases = await listReleases(listing.repo, { token: process.env.GITHUB_TOKEN });
  return releases.map((r) => ({
    label: r.tag,
    released: r.released,
    problem: r.problem,
    load: () => {
      if (r.xpi.size > config.maxXpiBytes) {
        throw new Error(`${r.xpi.name} is larger than ${config.maxXpiBytes} bytes.`);
      }
      return download(r.xpi.url, { maxBytes: config.maxXpiBytes });
    },
  }));
}

const { report } = await buildRegistry({
  config,
  listings,
  blocked,
  candidates,
  out: values.out,
  signingKey,
});

let listed = 0;
for (const entry of report) {
  listed += entry.listed ? 1 : 0;
  console.log(`${entry.id ?? entry.file}: ${entry.listed ? `listed (${entry.versions.join(", ")})` : "not listed"}`);
  for (const problem of entry.problems) {
    console.log(`  ${problem}`);
  }
  for (const { release, reasons } of entry.rejected) {
    console.log(`  ${release} rejected: ${reasons.join(" ")}`);
  }
}
console.log(`${listed} of ${report.length} listed in ${values.out}${signingKey ? "" : " (unsigned)"}`);

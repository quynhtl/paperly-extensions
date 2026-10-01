// Turning listings and releases into the published marketplace.
//
// Everything a person installs comes from the copy kept here, and the index
// names each copy's SHA-256, which Paperly's add-on manager checks before it
// installs anything. What was checked is therefore what is installed, even if
// a release asset on GitHub is replaced afterwards.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { slug, updateURL } from "./config.mjs";
import { inspectXpi } from "./inspect.mjs";
import { repoOwner, validateListing } from "./listing.mjs";
import { sign } from "./sign.mjs";
import { verifyPublisher as checkPublisherDomain } from "./verify.mjs";
import { compareVersions } from "./version.mjs";

const ICON_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg" };

/**
 * The most one extension's entry in index.json, or its update manifest, may
 * take. The checks keep what goes into them short: a listing with every
 * field as long as it may be, and five versions each naming as many web
 * addresses as are kept, come to under 64 KB, and most take a few. An
 * extension over this got something past them, and is left out rather than
 * make every copy of Paperly download it.
 */
const MAX_ENTRY_BYTES = 64 * 1024;

/**
 * The most index.json may take. Paperly gives up on a download after 30
 * seconds, and with the index it would lose every new block. Past this, the
 * largest extensions are left out until the rest fit.
 */
const MAX_INDEX_BYTES = 8 * 1024 * 1024;

/**
 * How many releases past versionsKept one run looks at, to make up for ones
 * that fail. Those that fail count too: each costs a download and a full
 * check, and an extension that published a hundred failing ones would
 * otherwise have every run check them all, until runs ran out of time and
 * nothing was published.
 */
const SPARE_RELEASES = 5;

const kb = (n) => `${Math.ceil(n / 1024)} KB`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Problems with blocked.json, which uses the format of Zotero's own
 * blocked-plugin list, plus one field: `"global": true`. Paperly applies a
 * block only to copies installed from the marketplace, so that a block aimed
 * at a listing cannot switch off a different plugin that shares its id; a
 * global block applies to every copy, for an id known to be malicious
 * wherever it comes from.
 */
export function validateBlocked(blocked) {
  const errors = [];
  if (!blocked || typeof blocked !== "object" || Array.isArray(blocked)) {
    return ["blocked.json must be an object keyed by extension id."];
  }
  for (const [id, entry] of Object.entries(blocked)) {
    if (!entry || typeof entry.reason !== "string" || !entry.reason.trim()) {
      errors.push(`${id}: a block needs a "reason" people can read.`);
    }
    const ranges = entry?.versionRanges;
    const rangeOK = (r) =>
      typeof r === "string" ||
      (r && typeof r === "object" && (typeof r.minVersion === "string" || typeof r.maxVersion === "string"));
    if (!Array.isArray(ranges) || !ranges.length || !ranges.every(rangeOK)) {
      errors.push(`${id}: "versionRanges" must list "*", versions, or { minVersion, maxVersion } objects.`);
    }
    if (entry?.global !== undefined && typeof entry.global !== "boolean") {
      errors.push(`${id}: "global" must be true or false.`);
    }
  }
  return errors;
}

/** The reason `version` of `id` is blocked, or null. */
export function blockedReason(blocked, id, version) {
  // Own entries only: an id such as "constructor" must not find one of
  // Object.prototype's members.
  const entry = Object.hasOwn(blocked, id) ? blocked[id] : null;
  if (!entry) {
    return null;
  }
  for (const range of entry.versionRanges) {
    if (typeof range === "string") {
      if (range === "*" || range === version) {
        return entry.reason;
      }
    } else if (
      (!range.minVersion || compareVersions(version, range.minVersion) >= 0) &&
      (!range.maxVersion || compareVersions(version, range.maxVersion) <= 0)
    ) {
      return entry.reason;
    }
  }
  return null;
}

function updateManifest(id, versions) {
  return {
    addons: {
      [id]: {
        updates: versions.map((v) => ({
          version: v.version,
          update_link: v.url,
          update_hash: `sha256:${v.sha256}`,
          applications: { zotero: { strict_min_version: v.minAppVersion, strict_max_version: v.maxAppVersion } },
        })),
      },
    },
  };
}

/** Removes whatever was written for one extension, so that none of it is served. */
function discard(out, id) {
  const name = slug(id);
  rmSync(join(out, "updates", `${name}.json`), { force: true });
  rmSync(join(out, "files", name), { recursive: true, force: true });
  for (const ext of Object.values(ICON_EXTENSIONS)) {
    rmSync(join(out, "icons", `${name}.${ext}`), { force: true });
  }
}

/**
 * Builds the marketplace into `out`:
 *
 *   index.json, index.json.sig       what the app reads
 *   updates/<slug>.json              what the add-on manager polls for updates
 *   files/<slug>/<slug>-<version>.xpi  the checked copies people install
 *   icons/<slug>.<ext>
 *   report.json                      what was accepted and rejected, and why
 *
 * `listings` is [{ file, listing }]. `candidates(listing)` resolves to that
 * extension's releases, newest first: [{ label, released, problem, load }],
 * where `load()` resolves to the .xpi's bytes. `log(line)` is given each
 * listing's id before it is built, so that a build stopped for taking too
 * long shows which one it was on.
 *
 * One extension can never stop the build: whatever goes wrong with it is
 * written in the report, and it is left out. Otherwise one bad release would
 * hold back every other extension's updates, and blocked.json with them.
 *
 * Nor can many of them: an index.json too large to publish leaves out the
 * largest extensions until the rest fit, each saying so in the report.
 * Anyone can have listings merged, as many as they have repositories, each
 * as large as the checks allow; were that to stop the build, one account
 * could hold back every block.
 *
 * The exception is an error marked `fatal`, such as GitHub not answering:
 * that is not about one extension, and building on regardless would publish
 * a marketplace missing the ones GitHub did not answer for. It is thrown, so
 * that nothing is deployed and the site already up stays up. blocked.json
 * too large to publish even with no extension listed is one too.
 */
export async function buildRegistry({
  config,
  listings,
  blocked,
  candidates,
  out,
  signingKey,
  verifyPublisher = checkPublisherDomain,
  log = () => {},
  now = new Date(),
}) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "updates"), { recursive: true });

  const report = [];
  const extensions = [];
  /** Each listed extension's entry in the report. */
  const reported = new Map();

  /** One valid listing's index entry, with its files written; null if nothing passed. */
  async function buildExtension(listing, entry) {
    // Every version blocked: nothing to download or check.
    const block = Object.hasOwn(blocked, listing.id) ? blocked[listing.id] : null;
    if (block?.versionRanges.includes("*")) {
      entry.problems.push(`Blocked: ${block.reason}`);
      return null;
    }

    let releases;
    try {
      releases = await candidates(listing);
    } catch (e) {
      if (e?.fatal) {
        throw e;
      }
      entry.problems.push(e.message);
      return null;
    }

    const accepted = [];
    let icon = null;
    const examined = releases.slice(0, config.versionsKept + SPARE_RELEASES);
    for (const release of examined) {
      if (accepted.length >= config.versionsKept) {
        break;
      }
      const reject = (...reasons) => entry.rejected.push({ release: release.label, reasons });
      if (release.problem) {
        reject(`The release ${release.problem}.`);
        continue;
      }
      let data;
      try {
        data = await release.load();
      } catch (e) {
        // GitHub not answering for the download is no fault of the release
        // (see download() in github.mjs): leaving the release out would
        // publish less, so the build stops.
        if (e?.fatal) {
          throw e;
        }
        reject(e.message);
        continue;
      }
      const result = inspectXpi(data, { listing, config });
      if (!result.ok) {
        reject(...result.findings.filter((f) => f.level === "error").map((f) => f.message));
        continue;
      }
      if (accepted.some((v) => compareVersions(v.version, result.version) === 0)) {
        reject(`Version ${result.version} is already published from a newer release.`);
        continue;
      }
      const block = blockedReason(blocked, listing.id, result.version);
      if (block) {
        reject(`Blocked: ${block}`);
        continue;
      }

      const name = `${slug(listing.id)}-${result.version}.xpi`;
      mkdirSync(join(out, "files", slug(listing.id)), { recursive: true });
      writeFileSync(join(out, "files", slug(listing.id), name), data);
      accepted.push({
        version: result.version,
        url: `${config.baseURL}files/${slug(listing.id)}/${name}`,
        sha256: createHash("sha256").update(data).digest("hex"),
        size: data.length,
        released: release.released ?? null,
        minAppVersion: result.minAppVersion,
        maxAppVersion: result.maxAppVersion,
        uses: result.detected.uses,
        hosts: result.detected.hosts,
        moreHosts: result.detected.moreHosts,
        findings: result.findings.map(({ level, code, message }) => ({ level, code, message })),
      });
      icon ??= result.icon;
    }

    accepted.sort((a, b) => compareVersions(b.version, a.version));
    entry.versions = accepted.map((v) => v.version);
    if (!accepted.length) {
      const among = releases.length > examined.length ? ` among the newest ${examined.length}, which are all a publish looks at` : "";
      entry.problems.push(`No release passed the checks${among}, so the extension is not listed.`);
      return null;
    }

    let iconURL = null;
    if (icon) {
      const iconName = `${slug(listing.id)}.${ICON_EXTENSIONS[icon.type]}`;
      mkdirSync(join(out, "icons"), { recursive: true });
      writeFileSync(join(out, "icons", iconName), icon.data);
      iconURL = `${config.baseURL}icons/${iconName}`;
    }

    const owner = repoOwner(listing);
    const official = config.officialOwners.includes(owner);
    const proof = await verifyPublisher(listing);
    if (proof.problem) {
      entry.problems.push(`Publisher not verified: ${proof.problem}`);
    }
    const extension = {
      id: listing.id,
      name: listing.name,
      description: listing.description,
      publisher: {
        name: listing.publisher || owner,
        github: owner,
        official,
        verified: official || proof.verified,
        domain: proof.verified ? proof.domain : null,
      },
      repo: listing.repo,
      homepage: listing.homepage ?? null,
      license: listing.license ?? null,
      privacyPolicy: listing.privacyPolicy ?? null,
      categories: listing.categories ?? [],
      icon: iconURL,
      declares: listing.declares,
      updateURL: updateURL(config, listing.id),
      versions: accepted,
    };
    const updates = JSON.stringify(updateManifest(listing.id, accepted), null, 2);
    for (const [what, text] of [
      ["entry in index.json", JSON.stringify(extension)],
      ["update manifest", updates],
    ]) {
      const size = Buffer.byteLength(text);
      if (size > MAX_ENTRY_BYTES) {
        throw new Error(`its ${what} would take ${kb(size)}, and one extension may take ${kb(MAX_ENTRY_BYTES)}.`);
      }
    }
    // The update manifest is written last: once it is there, installed copies
    // take what it offers.
    writeFileSync(join(out, "updates", `${slug(listing.id)}.json`), updates);
    return extension;
  }

  for (const { file, listing } of listings) {
    const entry = { id: listing?.id ?? null, file, listed: false, versions: [], rejected: [], problems: [] };
    report.push(entry);
    const errors = validateListing(listing, { fileName: basename(file) });
    if (errors.length) {
      entry.problems.push(...errors);
      continue;
    }
    // A delisted extension's listing stays only to keep its id taken.
    if (listing.delisted === true) {
      entry.problems.push("Delisted by its owner.");
      continue;
    }
    log(`Building ${listing.id}`);
    try {
      const extension = await buildExtension(listing, entry);
      if (extension) {
        extensions.push(extension);
        reported.set(extension, entry);
        entry.listed = true;
      }
    } catch (e) {
      if (e?.fatal) {
        throw e;
      }
      entry.problems.push(`The extension could not be built: ${e?.message ?? e}`);
      entry.versions = [];
      discard(out, listing.id);
    }
  }

  extensions.sort((a, b) => a.name.localeCompare(b.name));
  const index = {
    schema: 1,
    generated: now.toISOString(),
    baseURL: config.baseURL,
    appVersion: config.appVersion,
    extensions,
    blocked,
  };
  // The signature covers these exact bytes, so they are written once and
  // never re-serialised.
  let bytes = Buffer.from(JSON.stringify(index));
  if (bytes.length > MAX_INDEX_BYTES) {
    // Largest first, so that whoever made the index too large is who is left
    // out, and to leave out as few as can be.
    const sizes = new Map(extensions.map((e) => [e, Buffer.byteLength(JSON.stringify(e))]));
    const largest = [...extensions].sort((a, b) => sizes.get(b) - sizes.get(a) || a.id.localeCompare(b.id));
    const left = new Set();
    let size = bytes.length;
    for (const extension of largest) {
      if (size <= MAX_INDEX_BYTES) {
        break;
      }
      const entry = reported.get(extension);
      entry.problems.push(
        `Left out: index.json would be over the ${mb(MAX_INDEX_BYTES)} Paperly can be relied on to download, and at ${kb(sizes.get(extension))} this was the largest extension in it.`,
      );
      entry.listed = false;
      entry.versions = [];
      discard(out, extension.id);
      left.add(extension);
      // Its entry, and the comma between it and the next.
      size -= sizes.get(extension) + (left.size < extensions.length ? 1 : 0);
    }
    index.extensions = extensions.filter((e) => !left.has(e));
    bytes = Buffer.from(JSON.stringify(index));
    if (bytes.length > MAX_INDEX_BYTES) {
      const e = new Error(
        `index.json would take ${mb(bytes.length)} with no extension listed, over the ${mb(MAX_INDEX_BYTES)} Paperly can be relied on to download; blocked.json must be made smaller.`,
      );
      e.fatal = true;
      throw e;
    }
  }
  writeFileSync(join(out, "index.json"), bytes);
  if (signingKey) {
    writeFileSync(join(out, "index.json.sig"), await sign(bytes, signingKey));
  }
  writeFileSync(join(out, "report.json"), JSON.stringify({ generated: index.generated, extensions: report }, null, 2));
  // GitHub Pages would otherwise run the site through Jekyll.
  writeFileSync(join(out, ".nojekyll"), "");
  return { index, report };
}

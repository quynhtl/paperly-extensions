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

const ICON_EXTENSIONS = { "image/png": "png", "image/svg+xml": "svg", "image/jpeg": "jpg" };

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
 * where `load()` resolves to the .xpi's bytes.
 *
 * One extension can never stop the build: whatever goes wrong with it is
 * written in the report, and it is left out. Otherwise one bad release would
 * hold back every other extension's updates, and blocked.json with them.
 *
 * The exception is an error marked `fatal`, such as GitHub not answering:
 * that is not about one extension, and building on regardless would publish
 * a marketplace missing the ones GitHub did not answer for. It is thrown, so
 * that nothing is deployed and the site already up stays up.
 */
export async function buildRegistry({
  config,
  listings,
  blocked,
  candidates,
  out,
  signingKey,
  verifyPublisher = checkPublisherDomain,
  now = new Date(),
}) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "updates"), { recursive: true });

  const report = [];
  const extensions = [];

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
    for (const release of releases) {
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
        findings: result.findings.map(({ level, code, message }) => ({ level, code, message })),
      });
      icon ??= result.icon;
    }

    accepted.sort((a, b) => compareVersions(b.version, a.version));
    entry.versions = accepted.map((v) => v.version);
    if (!accepted.length) {
      entry.problems.push("No release passed the checks, so the extension is not listed.");
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
    // The update manifest is written last: once it is there, installed copies
    // take what it offers.
    writeFileSync(
      join(out, "updates", `${slug(listing.id)}.json`),
      JSON.stringify(updateManifest(listing.id, accepted), null, 2),
    );
    return {
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
    try {
      const extension = await buildExtension(listing, entry);
      if (extension) {
        extensions.push(extension);
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
  const bytes = Buffer.from(JSON.stringify(index));
  writeFileSync(join(out, "index.json"), bytes);
  if (signingKey) {
    writeFileSync(join(out, "index.json.sig"), await sign(bytes, signingKey));
  }
  writeFileSync(join(out, "report.json"), JSON.stringify({ generated: index.generated, extensions: report }, null, 2));
  // GitHub Pages would otherwise run the site through Jekyll.
  writeFileSync(join(out, ".nojekyll"), "");
  return { index, report };
}

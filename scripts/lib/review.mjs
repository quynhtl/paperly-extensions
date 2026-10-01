// Deciding whether a pull request can be merged without a maintainer.
//
// That is what makes listing open: a pull request that only adds or changes
// listings, comes from the owner of every repository involved, and whose
// listings pass the checks, is merged automatically. Anything else (scripts,
// blocked.json, someone else's listing, a repository owned by an
// organisation, a listing moved to another repository, a listing deleted)
// waits for a maintainer.
//
// A listing is never deleted, even to delist an extension: its owner sets
// "delisted": true instead. Every copy installed keeps asking the marketplace
// for updates under its id, so an id once listed must never be free for
// someone else to list; with the file kept, a later claim to it is a change
// to an existing listing, which a maintainer has to agree to.
//
// Ownership is decided by GitHub's numeric ids, never by names: a user or
// repository name can be given up and registered again by someone else, an id
// cannot. Organisations are left to a maintainer because GitHub does not say,
// to an outside token, who in one may speak for a repository; public
// membership alone lets any member list or repoint any of its repositories.
import { basename } from "node:path";
import { validateListing } from "./listing.mjs";

const LISTING_PATH = /^extensions\/[^/]+\.json$/;

/**
 * Every listing costs a few GitHub requests, from a budget the publish runs
 * share; a pull request touching more is left to a maintainer.
 */
const MAX_FILES = 10;

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * `files` are the pull request's changed files ({ filename, status,
 * previousFilename }), and `author` who opened it ({ login, id }). The
 * callbacks reach GitHub: `readHead` and `readBase` return a file's text in
 * the pull request and in the base branch (or null), `resolveRepo(repoId)`
 * the public repository with that numeric id ({ fullName, owner: { login, id,
 * type } }, or null), and `checkRelease(listing)` checks the newest release
 * ({ ok, label, version, findings } or { ok: false, problem }).
 *
 * Returns whether to merge, and the Markdown for the pull request comment.
 * What is marked ❌ is for the author to fix; what is marked ⏳ is not wrong,
 * but is for a maintainer to decide.
 */
export async function reviewSubmission({ author, files, readHead, readBase, resolveRepo, checkRelease }) {
  const lines = [];
  let merge = files.length > 0;
  let failures = 0;
  let waiting = 0;
  const pass = (text) => lines.push(`- ✅ ${text}`);
  const fail = (text) => {
    lines.push(`- ❌ ${text}`);
    merge = false;
    failures++;
  };
  const wait = (text) => {
    lines.push(`- ⏳ ${text}`);
    merge = false;
    waiting++;
  };

  async function checkOwner(listing, verb) {
    let repo;
    try {
      repo = Number.isSafeInteger(listing.repoId) ? await resolveRepo(listing.repoId) : null;
    } catch (e) {
      fail(`GitHub could not be asked about repository ${listing.repoId} (${e.message}); push again later.`);
      return;
    }
    if (!repo) {
      fail(`No public repository has the id ${listing.repoId}. \`node scripts/check.mjs --repo-id ${listing.repo}\` prints the right one.`);
    } else if (repo.fullName.toLowerCase() !== String(listing.repo).toLowerCase()) {
      fail(`Repository ${listing.repoId} is ${repo.fullName}, not ${listing.repo}. \`node scripts/check.mjs --repo-id ${listing.repo}\` prints the right id.`);
    } else if (repo.owner.type !== "User") {
      wait(`${listing.repo} belongs to the organisation ${repo.owner.login}, so a maintainer confirms who may list it.`);
    } else if (repo.owner.id !== author.id) {
      fail(`@${author.login} is not the owner of ${listing.repo}; a maintainer has to look at this.`);
    } else {
      pass(`@${author.login} ${verb} a listing for ${listing.repo}, which they own.`);
    }
  }

  if (files.length > MAX_FILES) {
    lines.push("");
    wait(`This pull request changes ${files.length} files. One that changes more than ${MAX_FILES} is not checked automatically: split it up, or wait for a maintainer.`);
    files = [];
  }

  for (const file of files) {
    const failuresBefore = failures;
    lines.push("", `**${file.filename}**, ${file.status}`);
    if (!LISTING_PATH.test(file.filename) || (file.previousFilename && !LISTING_PATH.test(file.previousFilename))) {
      wait("Only listings in `extensions/` are merged automatically; a maintainer will review this change.");
      continue;
    }

    if (file.status === "removed" || file.status === "renamed") {
      wait('Listings are never deleted or renamed, so that no one else can take their id. To delist an extension, set `"delisted": true` in its listing; a maintainer will look at this.');
      continue;
    }
    const isNew = file.status === "added" || file.status === "copied";
    if (!isNew && file.status !== "modified" && file.status !== "changed") {
      wait(`A maintainer will look at this change (${file.status}).`);
      continue;
    }

    const listing = parse(await readHead(file.filename));
    const errors = validateListing(listing, { fileName: basename(file.filename) });
    if (errors.length) {
      fail(`The listing has problems:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
      continue;
    }
    pass("The listing is valid.");

    if (!isNew) {
      // A listing's id and repository stay as first listed: moving it to
      // another repository hands its users' updates to whoever owns that one.
      const old = parse(await readBase(file.filename));
      if (
        !old ||
        typeof old !== "object" ||
        old.id !== listing.id ||
        old.repoId !== listing.repoId ||
        String(old.repo).toLowerCase() !== listing.repo.toLowerCase()
      ) {
        wait("This changes the repository (or the id) of a listing that already exists, which a maintainer has to confirm.");
      }
    }
    await checkOwner(listing, isNew ? "adds" : "changes");
    if (failures > failuresBefore) {
      lines.push("- The newest release is checked once the problems above are fixed.");
      continue;
    }
    if (listing.delisted === true) {
      pass("The extension is delisted: nothing of it is published, and the listing stays so that its id is never anyone else's.");
      continue;
    }

    const release = await checkRelease(listing);
    if (!release.ok) {
      fail(release.problem || `The newest release (${release.label}) does not pass the checks:`);
      for (const f of release.findings ?? []) {
        if (f.level === "error") {
          lines.push(`  - ${f.message}`);
        }
      }
      continue;
    }
    pass(`The newest release, ${release.label} (version ${release.version}), passes the checks.`);
    for (const f of release.findings) {
      lines.push(`  - ${f.level === "warning" ? "⚠️" : "ℹ️"} ${f.message}`);
    }
  }

  lines.push(
    "",
    merge
      ? "**Everything passed, so this is merged automatically.** The extension appears in Paperly after the next publish."
      : failures
        ? "**Not merged automatically.** Fix what is marked ❌ and push again, or wait for a maintainer."
        : "**Not merged automatically:** a maintainer will look at what is marked ⏳.",
  );
  return { merge, markdown: ["### Marketplace check", ...lines].join("\n") };
}

// Deciding whether a pull request can be merged without a maintainer.
//
// That is what makes listing open: a pull request that only adds, changes or
// removes listings, comes from the owner of every repository involved, and
// whose listings pass the checks, is merged automatically. Anything else
// (scripts, blocked.json, someone else's listing) waits for a maintainer.
import { basename } from "node:path";
import { repoOwner, validateListing } from "./listing.mjs";

const LISTING_PATH = /^extensions\/[^/]+\.json$/;

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * `files` are the pull request's changed files ({ filename, status,
 * previousFilename }). The callbacks reach GitHub: `readHead` and `readBase`
 * return a file's text in the pull request and in the base branch (or null),
 * `ownerAllows(owner, author)` says whether `author` speaks for `owner`, and
 * `checkRelease(listing)` checks the newest release ({ ok, label, version,
 * findings } or { ok: false, problem }).
 *
 * Returns whether to merge, and the Markdown for the pull request comment.
 */
export async function reviewSubmission({ author, files, readHead, readBase, ownerAllows, checkRelease }) {
  const lines = [];
  let merge = files.length > 0;
  const pass = (text) => lines.push(`- ✅ ${text}`);
  const fail = (text) => {
    lines.push(`- ❌ ${text}`);
    merge = false;
  };

  async function checkOwner(listing, verb) {
    const owner = repoOwner(listing);
    if (await ownerAllows(owner, author)) {
      pass(`@${author} ${verb} a listing for ${listing.repo}, which they own.`);
    } else {
      fail(`@${author} is not the owner of ${listing.repo} (or not a public member of ${owner}); a maintainer has to look at this.`);
    }
  }

  for (const file of files) {
    lines.push("", `**${file.filename}**, ${file.status}`);
    if (!LISTING_PATH.test(file.filename) || (file.previousFilename && !LISTING_PATH.test(file.previousFilename))) {
      fail("Only listings in `extensions/` are merged automatically; a maintainer will review this change.");
      continue;
    }

    if (file.status === "removed" || file.status === "renamed") {
      const old = parse(await readBase(file.previousFilename || file.filename));
      if (!old || typeof old !== "object") {
        fail("The listing being removed cannot be read.");
      } else {
        await checkOwner(old, "removes");
      }
      if (file.status === "removed") {
        continue;
      }
    }

    const listing = parse(await readHead(file.filename));
    const errors = validateListing(listing, { fileName: basename(file.filename) });
    if (errors.length) {
      fail(`The listing has problems:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
      continue;
    }
    pass("The listing is valid.");

    if (file.status === "modified") {
      const old = parse(await readBase(file.filename));
      if (old && typeof old === "object" && old.repo && repoOwner(old) !== repoOwner(listing)) {
        await checkOwner(old, "changes");
      }
    }
    await checkOwner(listing, file.status === "added" ? "adds" : "changes");

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
      : "**Not merged automatically.** Fix what is marked ❌ and push again, or wait for a maintainer.",
  );
  return { merge, markdown: ["### Marketplace check", ...lines].join("\n") };
}

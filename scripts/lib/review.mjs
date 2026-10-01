// Deciding whether a pull request can be merged without a maintainer.
//
// That is what makes listing open: a pull request that only adds or changes
// listings, comes from the owner of every repository involved, and whose
// listings pass the checks, is merged automatically. Anything else (scripts,
// blocked.json, someone else's listing, a repository owned by an
// organisation, a listing moved to another repository, a listing deleted)
// waits for a maintainer.
//
// A new id is merged automatically only when it is plainly the author's:
// name@<their login>.github.io, or under a publisherDomain that verifies.
// Otherwise anyone could list the id of a well-known plugin first and take
// over every copy of it already installed, which would offer the listed
// version as an update. Any other id waits for a maintainer.
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

/** The most finding lines shown for one release; a comment has a size limit. */
const MAX_FINDINGS = 20;

/**
 * Text that comes from the pull request or its release (file names, tags,
 * what the checks found, which quotes ids and code), made safe for the
 * comment: one line, capped, and set as inline code, so that no Markdown,
 * link, image or @mention in it takes effect. Without this, an id holding a
 * line break could add lines of its own to the bot's comment, such as a fake
 * "Everything passed".
 */
export function code(text, max = 300) {
  let line = String(text).replace(/[\r\n\u2028\u2029]+/g, " ");
  if (line.length > max) {
    line = `${line.slice(0, max)}…`;
  }
  // A backtick would end the code span; U+02CB looks the same and does not.
  return `\`${line.replaceAll("`", "\u02cb")}\``;
}

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
 * callbacks reach out: `readHead` and `readBase` return a file's text in the
 * pull request and in the base branch (or null), `resolveRepo(repoId)` the
 * public repository with that numeric id ({ fullName, owner: { login, id,
 * type } }, or null), `verifyPublisher(listing)` checks its publisherDomain
 * ({ verified, problem }, see verify.mjs), and `checkRelease(listing)` checks
 * the newest release ({ ok, label, version, findings } or { ok: false,
 * problem }).
 *
 * Returns whether to merge, and the Markdown for the pull request comment.
 * What is marked ❌ is for the author to fix; what is marked ⏳ is not wrong,
 * but is for a maintainer to decide.
 */
export async function reviewSubmission({ author, files, readHead, readBase, resolveRepo, verifyPublisher, checkRelease }) {
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
      fail(`GitHub could not be asked about repository ${listing.repoId} (${code(e.message)}); push again later.`);
      return;
    }
    if (!repo) {
      fail(`No public repository has the id ${listing.repoId}. ${code(`node scripts/check.mjs --repo-id ${listing.repo}`)} prints the right one.`);
    } else if (repo.fullName.toLowerCase() !== String(listing.repo).toLowerCase()) {
      fail(`Repository ${listing.repoId} is ${code(repo.fullName)}, not ${code(listing.repo)}. ${code(`node scripts/check.mjs --repo-id ${listing.repo}`)} prints the right id.`);
    } else if (repo.owner.type !== "User") {
      wait(`${code(listing.repo)} belongs to the organisation ${code(repo.owner.login)}, so a maintainer confirms who may list it.`);
    } else if (repo.owner.id !== author.id) {
      fail(`@${author.login} is not the owner of ${code(listing.repo)}; a maintainer has to look at this.`);
    } else {
      pass(`@${author.login} ${verb} a listing for ${code(listing.repo)}, which they own.`);
    }
  }

  async function checkNamespace(listing) {
    const at = listing.id.lastIndexOf("@");
    const domain = at > 0 ? listing.id.slice(at + 1).toLowerCase() : "";
    const pages = `${author.login.toLowerCase()}.github.io`;
    if (domain === pages) {
      pass(`The id is under ${pages}, which is @${author.login}'s.`);
      return;
    }
    const own = listing.publisherDomain?.toLowerCase();
    if (own && (domain === own || domain.endsWith(`.${own}`))) {
      const proof = await verifyPublisher(listing);
      if (proof.verified) {
        pass(`The id is under ${code(own)}, which is verified as the publisher of ${code(listing.repo)}.`);
      } else {
        wait(`The id is under ${code(own)}, but it did not verify (${code(proof.problem)}), so a maintainer will look at this.`);
      }
      return;
    }
    wait(
      `A new id is merged automatically only when it is yours: name@${pages}, or name@ your verified publisherDomain. A maintainer will look at this one.`,
    );
  }

  if (files.length > MAX_FILES) {
    lines.push("");
    wait(`This pull request changes ${files.length} files. One that changes more than ${MAX_FILES} is not checked automatically: split it up, or wait for a maintainer.`);
    files = [];
  }

  for (const file of files) {
    const failuresBefore = failures;
    lines.push("", `**${code(file.filename)}**, ${file.status}`);
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
      fail(`The listing has problems:\n${errors.map((e) => `  - ${code(e)}`).join("\n")}`);
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
    if (isNew && failures === failuresBefore) {
      await checkNamespace(listing);
    }
    if (failures > failuresBefore) {
      lines.push("- The newest release is checked once the problems above are fixed.");
      continue;
    }
    if (listing.delisted === true) {
      pass("The extension is delisted: nothing of it is published, and the listing stays so that its id is never anyone else's.");
      continue;
    }

    const release = await checkRelease(listing);
    const show = (findings, line) => {
      for (const f of findings.slice(0, MAX_FINDINGS)) {
        lines.push(line(f));
      }
      if (findings.length > MAX_FINDINGS) {
        lines.push(`  - and ${findings.length - MAX_FINDINGS} more; \`node scripts/check.mjs\` lists them all.`);
      }
    };
    if (!release.ok) {
      fail(release.problem ? code(release.problem) : `The newest release (${code(release.label)}) does not pass the checks:`);
      show((release.findings ?? []).filter((f) => f.level === "error"), (f) => `  - ${code(f.message)}`);
      continue;
    }
    pass(`The newest release, ${code(release.label)} (version ${code(release.version)}), passes the checks.`);
    show(release.findings, (f) => `  - ${f.level === "warning" ? "⚠️" : "ℹ️"} ${code(f.message)}`);
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

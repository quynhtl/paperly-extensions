#!/usr/bin/env node
// Runs in GitHub Actions on a pull request (see .github/workflows/listing.yml):
// checks the listings it touches, comments with the result, and writes
// merge=true to $GITHUB_OUTPUT when it can be merged without a maintainer.
//
// The job holds a token that can write to this repository, so nothing from the
// pull request is ever run: its listings are fetched through the API and read
// as JSON, and its releases are read by the ZIP reader, never unpacked.
//
// What is checked is the commit HEAD_SHA, the head the triggering event named,
// and only that commit may be merged: the merge step passes the sha written
// here to --match-head-commit, so GitHub refuses it if the head has moved.
import { appendFileSync } from "node:fs";
import { loadConfig } from "./lib/config.mjs";
import { download, listReleases, repoById } from "./lib/github.mjs";
import { inspectXpi } from "./lib/inspect.mjs";
import { reviewSubmission } from "./lib/review.mjs";
import { verifyPublisher } from "./lib/verify.mjs";

const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: registry, PR_NUMBER, HEAD_SHA, BASE_REF, GITHUB_OUTPUT } =
  process.env;
const number = Number(PR_NUMBER);
if (!token || !registry || !Number.isInteger(number) || !/^[0-9a-f]{40}$/.test(HEAD_SHA ?? "") || !BASE_REF) {
  console.error("Needs GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA and BASE_REF.");
  process.exit(2);
}
const MARKER = "<!-- paperly-marketplace-check -->";
const config = loadConfig();

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "paperly-extensions",
    },
    body: body && JSON.stringify(body),
  });
  return response;
}

async function json(path) {
  const response = await api(path);
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${path}`);
  }
  return response.json();
}

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

async function readFile(repo, path, ref) {
  const response = await api(`/repos/${repo}/contents/${encodePath(path)}?ref=${ref}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${path}`);
  }
  const { content, encoding } = await response.json();
  return encoding === "base64" ? Buffer.from(content, "base64").toString("utf8") : content;
}

/** Comments with the result, and tells the merge step whether to merge HEAD_SHA. */
async function finish(markdown, merge) {
  // One comment per pull request, updated on every push.
  const body = `${MARKER}\n${markdown}`;
  const comments = await json(`/repos/${registry}/issues/${number}/comments?per_page=100`);
  const previous = comments.find((c) => c.body?.startsWith(MARKER));
  const response = previous
    ? await api(`/repos/${registry}/issues/comments/${previous.id}`, { method: "PATCH", body: { body } })
    : await api(`/repos/${registry}/issues/${number}/comments`, { method: "POST", body: { body } });
  if (!response.ok) {
    console.error(`Could not comment: ${response.status}`);
  }

  console.log(markdown);
  if (GITHUB_OUTPUT) {
    appendFileSync(GITHUB_OUTPUT, `merge=${merge}\nsha=${HEAD_SHA}\n`);
  }
}

/**
 * Why the pull request as it stands is not the one this run was started for,
 * or null when it is: its head must still be HEAD_SHA, and its base the
 * repository's default branch.
 */
function moved(pr, defaultBranch) {
  if (pr.head.sha !== HEAD_SHA) {
    return "The pull request changed while it was being checked, so it is not merged automatically. Push again, or wait for a maintainer.";
  }
  if (pr.base.ref !== defaultBranch || BASE_REF !== defaultBranch) {
    return `Only pull requests into ${defaultBranch} are merged automatically; a maintainer will look at this one.`;
  }
  return null;
}

const stoppedMarkdown = (reason) => `### Marketplace check\n\n- ❌ ${reason}`;

const { default_branch: defaultBranch } = await json(`/repos/${registry}`);
const pr = await json(`/repos/${registry}/pulls/${number}`);
const before = moved(pr, defaultBranch);
if (before) {
  await finish(stoppedMarkdown(before), false);
  process.exit(0);
}

// The files of the checked commit itself, not of whatever the pull request
// holds by the time they are asked for.
const comparison = await json(`/repos/${registry}/compare/${pr.base.sha}...${HEAD_SHA}`);
const files = (comparison.files ?? []).map((f) => ({
  filename: f.filename,
  status: f.status,
  previousFilename: f.previous_filename,
}));

const review = await reviewSubmission({
  author: { login: pr.user.login, id: pr.user.id },
  files,
  readHead: (path) => readFile(pr.head.repo.full_name, path, HEAD_SHA),
  readBase: (path) => readFile(registry, path, pr.base.sha),
  resolveRepo: (repoId) => repoById(repoId, { token }),
  verifyPublisher,
  async checkRelease(listing) {
    let releases;
    try {
      releases = await listReleases(listing.repoId, { token });
    } catch (e) {
      return { ok: false, problem: e.message };
    }
    const newest = releases[0];
    if (!newest) {
      return { ok: false, problem: `${listing.repo} has no published release yet; publish one with the .xpi attached.` };
    }
    if (newest.problem) {
      return { ok: false, problem: `The newest release, ${newest.tag}, ${newest.problem}.` };
    }
    try {
      const data = await download(newest.xpi.url, { maxBytes: config.maxXpiBytes });
      const result = inspectXpi(data, { listing, config });
      return { ok: result.ok, label: newest.tag, version: result.version, findings: result.findings };
    } catch (e) {
      return { ok: false, problem: `The newest release, ${newest.tag}, could not be checked: ${e.message}` };
    }
  },
});

// The checks take a while. A push in the meantime must not be merged on the
// strength of them.
const after = review.merge ? moved(await json(`/repos/${registry}/pulls/${number}`), defaultBranch) : null;
await finish(after ? stoppedMarkdown(after) : review.markdown, review.merge && !after);

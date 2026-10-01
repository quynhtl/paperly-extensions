#!/usr/bin/env node
// Runs in GitHub Actions on a pull request (see .github/workflows/listing.yml):
// checks the listings it touches, comments with the result, and writes
// merge=true to $GITHUB_OUTPUT when it can be merged without a maintainer.
//
// The job holds a token that can write to this repository, so nothing from the
// pull request is ever run: its listings are fetched through the API and read
// as JSON, and its releases are read by the ZIP reader, never unpacked.
import { appendFileSync } from "node:fs";
import { loadConfig } from "./lib/config.mjs";
import { download, listReleases } from "./lib/github.mjs";
import { inspectXpi } from "./lib/inspect.mjs";
import { reviewSubmission } from "./lib/review.mjs";

const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: registry, PR_NUMBER, GITHUB_OUTPUT } = process.env;
const number = Number(PR_NUMBER);
if (!token || !registry || !Number.isInteger(number)) {
  console.error("Needs GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER.");
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

const pr = await json(`/repos/${registry}/pulls/${number}`);
const files = [];
for (let page = 1; ; page++) {
  const batch = await json(`/repos/${registry}/pulls/${number}/files?per_page=100&page=${page}`);
  files.push(...batch.map((f) => ({ filename: f.filename, status: f.status, previousFilename: f.previous_filename })));
  if (batch.length < 100) {
    break;
  }
}

const review = await reviewSubmission({
  author: pr.user.login,
  files,
  readHead: (path) => readFile(pr.head.repo.full_name, path, pr.head.sha),
  readBase: (path) => readFile(registry, path, pr.base.sha),
  async ownerAllows(owner, author) {
    if (owner.toLowerCase() === author.toLowerCase()) {
      return true;
    }
    // An organisation's repository: the author must be a public member.
    const response = await fetch(`https://api.github.com/orgs/${encodeURIComponent(owner)}/public_members/${encodeURIComponent(author)}`, {
      headers: { "User-Agent": "paperly-extensions", Authorization: `Bearer ${token}` },
    });
    return response.status === 204;
  },
  async checkRelease(listing) {
    let releases;
    try {
      releases = await listReleases(listing.repo, { token });
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

// One comment per pull request, updated on every push.
const body = `${MARKER}\n${review.markdown}`;
const comments = await json(`/repos/${registry}/issues/${number}/comments?per_page=100`);
const previous = comments.find((c) => c.body?.startsWith(MARKER));
const response = previous
  ? await api(`/repos/${registry}/issues/comments/${previous.id}`, { method: "PATCH", body: { body } })
  : await api(`/repos/${registry}/issues/${number}/comments`, { method: "POST", body: { body } });
if (!response.ok) {
  console.error(`Could not comment: ${response.status}`);
}

console.log(review.markdown);
if (GITHUB_OUTPUT) {
  appendFileSync(GITHUB_OUTPUT, `merge=${review.merge}\n`);
}

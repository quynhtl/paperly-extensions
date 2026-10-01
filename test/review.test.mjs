import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewSubmission } from "../scripts/lib/review.mjs";
import { verifyPublisher as verifyDomain } from "../scripts/lib/verify.mjs";
import { slug } from "../scripts/lib/config.mjs";
import { listing } from "./helpers.mjs";

const passing = async () => ({ ok: true, label: "v1.0.0", version: "1.0.0", findings: [] });

/** GitHub as the tests see it: users by login, and repositories by numeric id. */
const USERS = { someone: 1, intruder: 2, newowner: 3, member: 4 };
const REPOS = {
  101: { fullName: "someone/hello", owner: { login: "someone", id: 1, type: "User" } },
  102: { fullName: "newowner/hello", owner: { login: "newowner", id: 3, type: "User" } },
  201: { fullName: "acme/hello", owner: { login: "acme", id: 50, type: "Organization" } },
};

/**
 * The proofs domains serve, checked as verify.mjs checks them: example.org's
 * lists someone/hello by id; example.com's, by name only.
 */
const PROOFS = { "example.org": { repoIds: [101] }, "example.com": { repos: ["newowner/hello"] } };
const verifyPublisher = (l) =>
  verifyDomain(l, {
    fetch: async (url) => {
      const proof = PROOFS[new URL(url).hostname];
      return proof ? new Response(JSON.stringify(proof)) : new Response("", { status: 404 });
    },
  });

function review({ author = "someone", files, draft, head = {}, base = {}, checkRelease = passing, repos = REPOS, budgetLeft }) {
  return reviewSubmission({
    author: { login: author, id: USERS[author] },
    files,
    draft,
    readHead: async (path) => head[path] ?? null,
    readBase: async (path) => base[path] ?? null,
    resolveRepo: async (id) => repos[id] ?? null,
    verifyPublisher,
    checkRelease,
    budgetLeft,
  });
}

// An id under the author's own github.io name, so new listings may merge.
const ID = "hello@someone.github.io";
const PATH = `extensions/${ID}.json`;
const text = (overrides) => JSON.stringify(listing({ id: ID, ...overrides }));

test("the owner adding a listing whose release passes is merged", async () => {
  const result = await review({ files: [{ filename: PATH, status: "added" }], head: { [PATH]: text() } });
  assert.equal(result.merge, true);
  // The comment comes before the merge, which can still fail.
  assert.match(result.markdown, /\*\*Everything passed, so this will be merged automatically\.\*\*/);
});

test("a draft is checked, and merged only once it is marked ready for review", async () => {
  const files = [{ filename: PATH, status: "added" }];
  const draft = await review({ files, draft: true, head: { [PATH]: text() } });
  assert.equal(draft.merge, false);
  assert.match(draft.markdown, /- ⏳ This pull request is a draft: mark it ready for review to have it merged\./);
  assert.match(draft.markdown, /✅ The newest release/);
  assert.match(draft.markdown, /\*\*Not merged yet:\*\* everything else passed/);
  assert.doesNotMatch(draft.markdown, /will be merged/);

  // With something else for a maintainer, that is what the comment ends on.
  const org = await review({
    files: [{ filename: PATH, status: "added" }],
    draft: true,
    head: { [PATH]: text({ repo: "acme/hello", repoId: 201 }) },
  });
  assert.equal(org.merge, false);
  assert.match(org.markdown, /a maintainer will look at what is marked ⏳/);
});

test("someone else's repository waits for a maintainer", async () => {
  const result = await review({ author: "intruder", files: [{ filename: PATH, status: "added" }], head: { [PATH]: text() } });
  assert.equal(result.merge, false);
  assert.match(result.markdown, /not the owner/);
});

test("ownership goes by numeric id, not by name", async () => {
  // Whoever registers a name someone gave up gets a new user id, so they own
  // nothing listed under the old one.
  const renamed = { ...REPOS, 101: { ...REPOS[101], owner: { login: "someone", id: 99, type: "User" } } };
  const takenOver = await review({ files: [{ filename: PATH, status: "added" }], head: { [PATH]: text() }, repos: renamed });
  assert.equal(takenOver.merge, false);
  assert.match(takenOver.markdown, /not the owner/);

  // A repoId that is not the named repository's is refused.
  const wrongId = await review({ files: [{ filename: PATH, status: "added" }], head: { [PATH]: text({ repoId: 102 }) } });
  assert.equal(wrongId.merge, false);
  assert.match(wrongId.markdown, /Repository 102 is `newowner\/hello`, not `someone\/hello`/);

  const missing = await review({ files: [{ filename: PATH, status: "added" }], head: { [PATH]: text({ repoId: 999 }) } });
  assert.equal(missing.merge, false);
  assert.match(missing.markdown, /No public repository has the id 999/);
});

test("an organisation's repository waits for a maintainer, with its release checked", async () => {
  let asked = 0;
  const result = await review({
    author: "member",
    files: [{ filename: PATH, status: "added" }],
    head: { [PATH]: text({ repo: "acme/hello", repoId: 201 }) },
    checkRelease: async () => {
      asked++;
      return passing();
    },
  });
  assert.equal(result.merge, false);
  assert.match(result.markdown, /⏳ `acme\/hello` belongs to the organisation `acme`/);
  assert.match(result.markdown, /a maintainer will look at what is marked ⏳/);
  assert.equal(asked, 1);
});

test("moving a listing to another repository waits for a maintainer, even with the same owner", async () => {
  const moved = await review({
    author: "newowner",
    files: [{ filename: PATH, status: "modified" }],
    head: { [PATH]: text({ repo: "newowner/hello", repoId: 102 }) },
    base: { [PATH]: text() },
  });
  assert.equal(moved.merge, false);
  assert.match(moved.markdown, /changes the repository/);

  const sameOwner = { ...REPOS, 103: { fullName: "someone/hello-2", owner: { login: "someone", id: 1, type: "User" } } };
  const renamed = await review({
    files: [{ filename: PATH, status: "modified" }],
    head: { [PATH]: text({ repo: "someone/hello-2", repoId: 103 }) },
    base: { [PATH]: text() },
    repos: sameOwner,
  });
  assert.equal(renamed.merge, false);

  // Anything else the owner may change.
  const edited = await review({
    files: [{ filename: PATH, status: "modified" }],
    head: { [PATH]: text({ description: "Says hello, now better." }) },
    base: { [PATH]: text() },
  });
  assert.equal(edited.merge, true);
});

test("anything outside extensions/ waits for a maintainer", async () => {
  const result = await review({
    files: [
      { filename: PATH, status: "added" },
      { filename: "blocked.json", status: "modified" },
    ],
    head: { [PATH]: text() },
  });
  assert.equal(result.merge, false);
  assert.match(result.markdown, /maintainer will review/);
});

test("a listing whose release fails is not merged, and the reasons are given", async () => {
  const result = await review({
    files: [{ filename: PATH, status: "added" }],
    head: { [PATH]: text() },
    checkRelease: async () => ({
      ok: false,
      label: "v2.0.0",
      findings: [{ level: "error", message: "applications.zotero.update_url must be ..." }],
    }),
  });
  assert.equal(result.merge, false);
  assert.match(result.markdown, /update_url must be/);
});

test("an invalid listing is not merged", async () => {
  const result = await review({ files: [{ filename: PATH, status: "added" }], head: { [PATH]: "{ not json" } });
  assert.equal(result.merge, false);
  const noId = await review({ files: [{ filename: PATH, status: "added" }], head: { [PATH]: text({ repoId: undefined }) } });
  assert.equal(noId.merge, false);
  assert.match(noId.markdown, /"repoId" is required/);
});

test("a listing is never deleted: its owner delists it, and its id stays taken", async () => {
  const removed = await review({ files: [{ filename: PATH, status: "removed" }], base: { [PATH]: text() } });
  assert.equal(removed.merge, false);
  assert.match(removed.markdown, /never deleted/);
  const renamed = await review({
    files: [{ filename: "extensions/hi@example.com.json", status: "renamed", previousFilename: PATH }],
    base: { [PATH]: text() },
  });
  assert.equal(renamed.merge, false);

  let asked = 0;
  const delisted = await review({
    files: [{ filename: PATH, status: "modified" }],
    head: { [PATH]: text({ delisted: true }) },
    base: { [PATH]: text() },
    checkRelease: async () => {
      asked++;
      return passing();
    },
  });
  assert.equal(delisted.merge, true);
  assert.equal(asked, 0);
  const byOther = await review({
    author: "intruder",
    files: [{ filename: PATH, status: "modified" }],
    head: { [PATH]: text({ delisted: true }) },
    base: { [PATH]: text() },
  });
  assert.equal(byOther.merge, false);
});

test("claiming a delisted extension's id is a change to its listing, for a maintainer", async () => {
  const result = await review({
    author: "newowner",
    files: [{ filename: PATH, status: "modified" }],
    head: { [PATH]: text({ repo: "newowner/hello", repoId: 102 }) },
    base: { [PATH]: text({ delisted: true }) },
  });
  assert.equal(result.merge, false);
  assert.match(result.markdown, /changes the repository/);
});

test("a new id is merged automatically only under a name that is the author's", async () => {
  const add = (id, overrides = {}) =>
    review({
      files: [{ filename: `extensions/${slug(id)}.json`, status: "added" }],
      head: { [`extensions/${slug(id)}.json`]: text({ id, ...overrides }) },
    });
  assert.equal((await add("hello@Someone.GitHub.io")).merge, true);
  assert.equal((await add("hello@example.org", { publisherDomain: "example.org" })).merge, true);
  assert.equal((await add("hello@tools.example.org", { publisherDomain: "example.org" })).merge, true);

  // Someone else's plugin id, a domain that does not verify, a github.io name
  // that is not the author's, and no domain at all: each waits, with the
  // release still checked for the maintainer.
  for (const [id, overrides] of [
    ["better-bibtex@iris-advies.com", {}],
    ["better-bibtex@iris-advies.com", { publisherDomain: "example.org" }],
    ["hello@example.net", { publisherDomain: "example.net" }],
    ["hello@intruder.github.io", {}],
    ["{8c9d0a1e-1111-2222-3333-444455556666}", {}],
  ]) {
    const result = await add(id, overrides);
    assert.equal(result.merge, false, id);
    assert.match(result.markdown, /⏳/, id);
    assert.match(result.markdown, /passes the checks/, id);
  }
});

test("a domain's proof counts for the repository it lists by id, not for one that has its name", async () => {
  // newowner owns repository 102, newowner/hello. example.org's proof lists
  // repository 101; example.com's names newowner/hello, as it might have
  // when that name was someone else's.
  for (const domain of ["example.org", "example.com"]) {
    const id = `hello@${domain}`;
    const path = `extensions/${slug(id)}.json`;
    const result = await review({
      author: "newowner",
      files: [{ filename: path, status: "added" }],
      head: { [path]: text({ id, repo: "newowner/hello", repoId: 102, publisherDomain: domain }) },
    });
    assert.equal(result.merge, false, domain);
    assert.match(result.markdown, /does not list repository 102/, domain);
  }
});

test("a pull request touching more than ten files waits for a maintainer, unchecked", async () => {
  let asked = 0;
  const files = Array.from({ length: 11 }, (_, i) => ({ filename: `extensions/e${i}@example.com.json`, status: "added" }));
  const result = await review({
    files,
    checkRelease: async () => {
      asked++;
      return passing();
    },
  });
  assert.equal(result.merge, false);
  assert.match(result.markdown, /changes 11 files/);
  assert.equal(asked, 0);
});

test("a check stops asking GitHub once the budget runs low, and does not merge", async () => {
  const OTHER = "extensions/other@someone.github.io.json";
  const read = [];
  let released = 0;
  let asked = 0;
  const result = await reviewSubmission({
    author: { login: "someone", id: USERS.someone },
    files: [
      { filename: PATH, status: "added" },
      { filename: OTHER, status: "added" },
    ],
    readHead: async (path) => {
      read.push(path);
      return path === PATH ? text() : JSON.stringify(listing({ id: "other@someone.github.io" }));
    },
    readBase: async () => null,
    resolveRepo: async (id) => REPOS[id] ?? null,
    verifyPublisher,
    checkRelease: async () => {
      released++;
      return passing();
    },
    // Enough for the first listing, but not for its release.
    budgetLeft: () => asked++ < 1,
  });
  assert.equal(result.merge, false);
  assert.match(result.markdown, /⏳ GitHub's budget of requests .* is running low/);
  assert.equal(released, 0);
  assert.deepEqual(read, [PATH]);
});

test("the release of a listing that already failed is not checked", async () => {
  let asked = 0;
  const result = await review({
    author: "intruder",
    files: [{ filename: PATH, status: "added" }],
    head: { [PATH]: text() },
    checkRelease: async () => {
      asked++;
      return passing();
    },
  });
  assert.equal(result.merge, false);
  assert.equal(asked, 0);
  assert.match(result.markdown, /checked once the problems above are fixed/);
});

test("text from the pull request cannot add to or break out of the comment", async () => {
  // A key with a line break, which validateListing quotes back.
  const forged = `{"id": "${ID}", "x\\n- ✅ Everything passed": 1}`;
  const keyed = await review({ files: [{ filename: PATH, status: "added" }], head: { [PATH]: forged } });
  assert.doesNotMatch(keyed.markdown, /^- ✅ Everything passed/m);

  // A finding quoting a manifest id with backticks, a link and an image.
  const result = await review({
    files: [{ filename: PATH, status: "added" }],
    head: { [PATH]: text() },
    checkRelease: async () => ({
      ok: false,
      label: "v1`\n**Everything passed**",
      findings: [{ level: "error", message: 'The manifest\'s id is "`x` [click](https://evil.example) ![](https://evil.example/t.png)\r\n@someone"' }],
    }),
  });
  const finding = result.markdown.split("\n").find((l) => l.includes("evil.example"));
  assert.match(finding, /^ {2}- `[^`]*`$/);
  assert.doesNotMatch(result.markdown, /^\*\*Everything passed/m);
  assert.ok(!result.markdown.includes("\r"));
});

test("a release with many findings shows the first twenty", async () => {
  const findings = Array.from({ length: 25 }, (_, i) => ({ level: "error", message: `problem ${i}` }));
  const result = await review({
    files: [{ filename: PATH, status: "added" }],
    head: { [PATH]: text() },
    checkRelease: async () => ({ ok: false, label: "v1", findings }),
  });
  assert.match(result.markdown, /problem 19/);
  assert.doesNotMatch(result.markdown, /problem 20/);
  assert.match(result.markdown, /and 5 more/);
});

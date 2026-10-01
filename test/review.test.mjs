import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewSubmission } from "../scripts/lib/review.mjs";
import { listing } from "./helpers.mjs";

const passing = async () => ({ ok: true, label: "v1.0.0", version: "1.0.0", findings: [] });

/** GitHub as the tests see it: users by login, and repositories by numeric id. */
const USERS = { someone: 1, intruder: 2, newowner: 3, member: 4 };
const REPOS = {
  101: { fullName: "someone/hello", owner: { login: "someone", id: 1, type: "User" } },
  102: { fullName: "newowner/hello", owner: { login: "newowner", id: 3, type: "User" } },
  201: { fullName: "acme/hello", owner: { login: "acme", id: 50, type: "Organization" } },
};

function review({ author = "someone", files, head = {}, base = {}, checkRelease = passing, repos = REPOS }) {
  return reviewSubmission({
    author: { login: author, id: USERS[author] },
    files,
    readHead: async (path) => head[path] ?? null,
    readBase: async (path) => base[path] ?? null,
    resolveRepo: async (id) => repos[id] ?? null,
    checkRelease,
  });
}

const PATH = "extensions/hello@example.com.json";
const text = (overrides) => JSON.stringify(listing(overrides));

test("the owner adding a listing whose release passes is merged", async () => {
  const result = await review({ files: [{ filename: PATH, status: "added" }], head: { [PATH]: text() } });
  assert.equal(result.merge, true);
  assert.match(result.markdown, /merged automatically/);
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
  assert.match(wrongId.markdown, /Repository 102 is newowner\/hello, not someone\/hello/);

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
  assert.match(result.markdown, /⏳ acme\/hello belongs to the organisation acme/);
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

test("owners may remove their own listing", async () => {
  const removed = await review({ files: [{ filename: PATH, status: "removed" }], base: { [PATH]: text() } });
  assert.equal(removed.merge, true);
  const byOther = await review({ author: "intruder", files: [{ filename: PATH, status: "removed" }], base: { [PATH]: text() } });
  assert.equal(byOther.merge, false);
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

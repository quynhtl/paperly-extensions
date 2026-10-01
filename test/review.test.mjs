import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewSubmission } from "../scripts/lib/review.mjs";
import { listing } from "./helpers.mjs";

const passing = async () => ({ ok: true, label: "v1.0.0", version: "1.0.0", findings: [] });

function review({ author = "someone", files, head = {}, base = {}, checkRelease = passing, members = {} }) {
  return reviewSubmission({
    author,
    files,
    readHead: async (path) => head[path] ?? null,
    readBase: async (path) => base[path] ?? null,
    ownerAllows: async (owner, who) => owner === who || (members[owner] ?? []).includes(who),
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

test("a public member may list an organisation's repository", async () => {
  const result = await review({
    author: "member",
    files: [{ filename: PATH, status: "added" }],
    head: { [PATH]: text({ repo: "acme/hello" }) },
    members: { acme: ["member"] },
  });
  assert.equal(result.merge, true);
});

test("moving a listing to another owner's repository needs both owners", async () => {
  const result = await review({
    author: "newowner",
    files: [{ filename: PATH, status: "modified" }],
    head: { [PATH]: text({ repo: "newowner/hello" }) },
    base: { [PATH]: text() },
  });
  assert.equal(result.merge, false);
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
});

test("owners may remove their own listing", async () => {
  const removed = await review({ files: [{ filename: PATH, status: "removed" }], base: { [PATH]: text() } });
  assert.equal(removed.merge, true);
  const byOther = await review({ author: "other", files: [{ filename: PATH, status: "removed" }], base: { [PATH]: text() } });
  assert.equal(byOther.merge, false);
});

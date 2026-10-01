import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubError, listReleases, repoById } from "../scripts/lib/github.mjs";

const release = (tag, extra = {}) => ({
  tag_name: tag,
  published_at: "2026-10-01T00:00:00Z",
  assets: [{ name: `${tag}.xpi`, browser_download_url: `https://example.com/${tag}.xpi`, size: 10 }],
  ...extra,
});

/** A fetch that answers with `answer(url, n)` for the n-th request, and records what was asked. */
function fakeFetch(answer) {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    const { status = 200, body = [], headers = {} } = answer(url, urls.length);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { fetch, urls };
}

const noWait = async () => {};

test("pages are read until enough published releases are found", async () => {
  const betas = Array.from({ length: 100 }, (_, i) => release(`v2.0.0-beta.${i}`, { prerelease: true }));
  const { fetch, urls } = fakeFetch((url) => ({
    body: url.endsWith("&page=1") ? betas : [release("v1.4.0"), release("v1.3.0")],
  }));
  const releases = await listReleases("someone/hello", { fetch, want: 1 });
  assert.deepEqual(releases.map((r) => r.tag), ["v1.4.0", "v1.3.0"]);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /per_page=100&page=1$/);
});

test("reading stops at the page limit", async () => {
  const drafts = Array.from({ length: 100 }, (_, i) => release(`d${i}`, { draft: true }));
  const { fetch, urls } = fakeFetch(() => ({ body: drafts }));
  assert.deepEqual(await listReleases("someone/hello", { fetch, want: 5, maxPages: 3 }), []);
  assert.equal(urls.length, 3);
});

test("what GitHub may answer later is asked again", async () => {
  const waits = [];
  const answers = [
    { status: 502 },
    { status: 403, body: { message: "You have exceeded a secondary rate limit." }, headers: { "retry-after": "2" } },
    { status: 429 },
    { body: [release("v1.0.0")] },
  ];
  const { fetch } = fakeFetch((url, n) => answers[n - 1]);
  const releases = await listReleases("someone/hello", { fetch, wait: async (ms) => waits.push(ms) });
  assert.deepEqual(releases.map((r) => r.tag), ["v1.0.0"]);
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test("a failure that persists, or is no rate limit, stops the build", async () => {
  for (const answer of [() => ({ status: 500 }), () => ({ status: 403, body: { message: "Forbidden" } }), () => ({ body: "<html>" })]) {
    const { fetch } = fakeFetch(answer);
    await assert.rejects(listReleases("someone/hello", { fetch, wait: noWait }), (e) => e instanceof GitHubError && e.fatal);
  }
  const unreachable = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(listReleases("someone/hello", { fetch: unreachable, wait: noWait }), /could not be reached/);
  // A wait of more than a minute is not worth it.
  const { fetch } = fakeFetch(() => ({ status: 429, headers: { "retry-after": "3600" } }));
  await assert.rejects(listReleases("someone/hello", { fetch, wait: noWait }), GitHubError);
});

test("a repository that is gone lists nothing, without stopping the build", async () => {
  const { fetch } = fakeFetch(() => ({ status: 404, body: { message: "Not Found" } }));
  await assert.rejects(listReleases("someone/hello", { fetch }), (e) => !e.fatal && /not found/.test(e.message));
});

test("repositories and their releases are found by numeric id", async () => {
  const { fetch, urls } = fakeFetch((url) =>
    url.endsWith("/repositories/101")
      ? { body: { id: 101, full_name: "someone/hello", owner: { login: "someone", id: 1, type: "User" } } }
      : url.includes("/repositories/101/releases")
        ? { body: [release("v1.0.0")] }
        : { status: 404, body: { message: "Not Found" } },
  );
  assert.deepEqual(await repoById(101, { fetch }), {
    id: 101,
    fullName: "someone/hello",
    owner: { login: "someone", id: 1, type: "User" },
  });
  assert.equal(await repoById(102, { fetch }), null);
  assert.deepEqual((await listReleases(101, { fetch })).map((r) => r.tag), ["v1.0.0"]);
  assert.match(urls[0], /^https:\/\/api\.github\.com\/repositories\/101$/);
});

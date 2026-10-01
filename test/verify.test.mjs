import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPublisher, WELL_KNOWN_PATH } from "../scripts/lib/verify.mjs";
import { buildRegistry } from "../scripts/lib/build.mjs";
import { validateListing } from "../scripts/lib/listing.mjs";
import { config, listing, xpi } from "./helpers.mjs";

/**
 * A fetch that serves `body` (a string, a ReadableStream, or an Error to
 * throw) and records what was asked.
 */
function fakeFetch(body, status = 200) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (body instanceof Error) {
      throw body;
    }
    return new Response(body, { status });
  };
  return { fetch, calls };
}

const withDomain = listing({ publisherDomain: "example.org" });

test("a domain that lists the repository verifies its publisher", async () => {
  const { fetch, calls } = fakeFetch(JSON.stringify({ repos: ["Someone/Hello"] }));
  assert.deepEqual(await verifyPublisher(withDomain, { fetch }), { verified: true, domain: "example.org", problem: null });
  assert.equal(calls[0].url, `https://example.org${WELL_KNOWN_PATH}`);
  // A redirect could hand the proof to another host
  assert.equal(calls[0].options.redirect, "error");
});

test("no domain, no check", async () => {
  const { fetch, calls } = fakeFetch("{}");
  assert.deepEqual(await verifyPublisher(listing(), { fetch }), { verified: false, domain: null, problem: null });
  assert.equal(calls.length, 0);
});

test("anything short of the repository in the file leaves the publisher unverified, with the reason", async () => {
  const cases = [
    [fakeFetch(JSON.stringify({ repos: ["someone/other"] })), /does not list someone\/hello/],
    [fakeFetch("not json"), /not valid JSON/],
    [fakeFetch("", 404), /answered 404/],
    [fakeFetch(new TypeError("redirect mode is set to error")), /could not be fetched/],
    [fakeFetch("x".repeat(70 * 1024)), /larger than/],
    // Entries that are not names, one of which String() cannot convert.
    [fakeFetch(JSON.stringify({ repos: [{ toString: 1 }, ["someone/hello"], null] })), /does not list someone\/hello/],
  ];
  for (const [{ fetch }, reason] of cases) {
    const result = await verifyPublisher(withDomain, { fetch });
    assert.equal(result.verified, false);
    assert.match(result.problem, reason);
  }
});

test("a body that fails or never ends leaves the publisher unverified, without throwing", async () => {
  // Headers arrive, then the connection drops.
  const dropped = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"repos": ['));
      controller.error(new TypeError("terminated"));
    },
  });
  let result = await verifyPublisher(withDomain, fakeFetch(dropped));
  assert.equal(result.verified, false);
  assert.match(result.problem, /could not be fetched \(terminated\)/);

  // A body that would go on for ever is cut off at the limit.
  let sent = 0;
  const endless = new ReadableStream({
    pull(controller) {
      sent += 16 * 1024;
      controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
    },
  });
  result = await verifyPublisher(withDomain, fakeFetch(endless));
  assert.match(result.problem, /larger than/);
  assert.ok(sent < 200 * 1024);
});

test("a listing's publisherDomain must be a domain name", () => {
  assert.deepEqual(validateListing(withDomain), []);
  assert.equal(validateListing(listing({ publisherDomain: "https://example.org" })).length, 1);
  assert.equal(validateListing(listing({ publisherDomain: "10.0.0.1" })).length, 1);
});

test("the index marks a verified publisher and names the domain", async () => {
  const { index, report } = await buildRegistry({
    config,
    listings: [
      { file: "hello@example.com.json", listing: withDomain },
      { file: "other@example.com.json", listing: listing({ id: "other@example.com", publisherDomain: "example.net" }) },
    ],
    blocked: {},
    candidates: async (l) => [
      {
        label: "v1",
        released: null,
        load: async () => xpi({ manifest: JSON.parse(JSON.stringify(manifestFor(l.id))) }),
      },
    ],
    verifyPublisher: async (l) =>
      l.publisherDomain === "example.org"
        ? { verified: true, domain: "example.org", problem: null }
        : { verified: false, domain: l.publisherDomain, problem: "answered 404." },
    out: mkdtempSync(join(tmpdir(), "paperly-verify-")),
  });
  const hello = index.extensions.find((e) => e.id === "hello@example.com");
  const other = index.extensions.find((e) => e.id === "other@example.com");
  assert.deepEqual(hello.publisher, { name: "someone", github: "someone", official: false, verified: true, domain: "example.org" });
  assert.deepEqual(other.publisher.verified, false);
  assert.equal(other.publisher.domain, null);
  assert.match(report[1].problems[0], /Publisher not verified: answered 404/);
});

function manifestFor(id) {
  return {
    manifest_version: 2,
    name: id,
    version: "1.0.0",
    applications: {
      zotero: {
        id,
        update_url: `https://registry.test/updates/${id}.json`,
        strict_min_version: "9.0",
        strict_max_version: "11.*",
      },
    },
  };
}

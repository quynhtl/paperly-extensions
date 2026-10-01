import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { validateListing } from "../scripts/lib/listing.mjs";
import { slug } from "../scripts/lib/config.mjs";
import { listing } from "./helpers.mjs";

test("a complete listing passes", () => {
  assert.deepEqual(
    validateListing(
      listing({
        publisher: "Someone",
        categories: ["ai", "writing"],
        homepage: "https://example.com/hello",
        license: "MIT",
        privacyPolicy: "https://example.com/privacy",
        declares: { network: ["api.example.com"], sendsContent: true, clipboard: false },
      }),
      { fileName: "hello@example.com.json" },
    ),
    [],
  );
});

test("every listing in this repository passes", () => {
  const dir = new URL("../extensions/", import.meta.url);
  for (const file of readdirSync(dir)) {
    const errors = validateListing(JSON.parse(readFileSync(new URL(file, dir), "utf8")), { fileName: file });
    assert.deepEqual(errors, [], file);
  }
});

test("missing and unknown fields are both errors", () => {
  const { declares, ...rest } = listing();
  const errors = validateListing({ ...rest, verified: true });
  assert.ok(errors.some((e) => e.includes('"declares" is required')));
  assert.ok(errors.some((e) => e.includes('Unknown field "verified"')));
});

test("the file is named after the id", () => {
  assert.match(validateListing(listing(), { fileName: "hello.json" })[0], /hello@example\.com\.json/);
  assert.equal(slug("{8c9d-11}"), "_8c9d-11_");
});

test("declares only takes known keys, and hosts are host names", () => {
  const errors = validateListing(
    listing({ declares: { network: ["https://api.example.com/"], camera: true, clipboard: "yes" } }),
  );
  assert.equal(errors.length, 3);
});

test("repo, URLs, categories and lengths are checked", () => {
  const errors = validateListing(
    listing({
      repo: "https://github.com/someone/hello",
      homepage: "http://example.com",
      categories: ["ai", "games"],
      name: "x".repeat(51),
    }),
  );
  assert.equal(errors.length, 4);
});

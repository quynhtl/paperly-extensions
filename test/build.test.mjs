import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedReason, buildRegistry, validateBlocked } from "../scripts/lib/build.mjs";
import { generateKeys, publicKeyOf, verify } from "../scripts/lib/sign.mjs";
import { config, listing, manifest, xpi } from "./helpers.mjs";

const release = (label, data, extra = {}) => ({ label, released: "2026-10-01T00:00:00Z", load: async () => data, ...extra });
const xpiAt = (version, zotero = {}) => xpi({ manifest: manifest({ version, zotero }) });
const outDir = () => mkdtempSync(join(tmpdir(), "paperly-registry-"));

test("a build lists what passes, keeps the checked copies, and signs the index", async () => {
  const keys = await generateKeys();
  const out = outDir();
  const v11 = xpiAt("1.1.0");
  const { index, report } = await buildRegistry({
    config,
    listings: [{ file: "extensions/hello@example.com.json", listing: listing({ declares: { network: [] } }) }],
    blocked: {},
    candidates: async () => [
      release("v1.2.0", xpiAt("1.2.0", { update_url: "https://elsewhere.example/u.json" })),
      release("v1.1.0", v11),
      release("v1.0.5", null, { problem: "has no .xpi attached" }),
      release("v1.0.0", xpiAt("1.0.0")),
    ],
    out,
    signingKey: keys.privateKey,
  });

  const [hello] = index.extensions;
  assert.deepEqual(hello.versions.map((v) => v.version), ["1.1.0", "1.0.0"]);
  assert.equal(hello.publisher.name, "someone");
  assert.equal(hello.publisher.verified, false);
  assert.equal(hello.icon, "https://registry.test/icons/hello@example.com.png");
  assert.equal(hello.versions[0].url, "https://registry.test/files/hello@example.com/hello@example.com-1.1.0.xpi");

  // The copy on disk is the one the hash names.
  const kept = readFileSync(join(out, "files/hello@example.com/hello@example.com-1.1.0.xpi"));
  assert.deepEqual(kept, v11);
  assert.equal(hello.versions[0].sha256, createHash("sha256").update(kept).digest("hex"));

  // The signature covers the bytes on disk.
  const bytes = readFileSync(join(out, "index.json"));
  assert.equal(await verify(bytes, readFileSync(join(out, "index.json.sig"), "utf8"), keys.publicKey), true);
  const tampered = Buffer.from(bytes.toString().replace("Says hello.", "Says goodbye."));
  assert.equal(await verify(tampered, readFileSync(join(out, "index.json.sig"), "utf8"), keys.publicKey), false);

  // The add-on manager's update manifest offers the same copies and hashes.
  const updates = JSON.parse(readFileSync(join(out, "updates/hello@example.com.json"), "utf8"));
  assert.deepEqual(updates.addons["hello@example.com"].updates[0], {
    version: "1.1.0",
    update_link: hello.versions[0].url,
    update_hash: `sha256:${hello.versions[0].sha256}`,
    applications: { zotero: { strict_min_version: "9.0", strict_max_version: "11.*" } },
  });

  const [entry] = report;
  assert.equal(entry.listed, true);
  assert.deepEqual(entry.rejected.map((r) => r.release), ["v1.2.0", "v1.0.5"]);
  assert.match(entry.rejected[0].reasons[0], /update_url/);
  assert.ok(existsSync(join(out, "report.json")));
});

test("blocked versions are not offered, and the block travels in the index", async () => {
  const blocked = { "hello@example.com": { versionRanges: [{ maxVersion: "1.0.9" }], reason: "Leaks the library." } };
  const { index } = await buildRegistry({
    config,
    listings: [{ file: "hello@example.com.json", listing: listing() }],
    blocked,
    candidates: async () => [release("v1.1.0", xpiAt("1.1.0")), release("v1.0.0", xpiAt("1.0.0"))],
    out: outDir(),
  });
  assert.deepEqual(index.extensions[0].versions.map((v) => v.version), ["1.1.0"]);
  assert.deepEqual(index.blocked, blocked);
  assert.equal(blockedReason(blocked, "hello@example.com", "1.0.0"), "Leaks the library.");
  assert.equal(blockedReason(blocked, "hello@example.com", "1.1.0"), null);
  assert.equal(blockedReason({ x: { versionRanges: ["*"], reason: "r" } }, "x", "9"), "r");
});

test("a delisted extension is not published, and nothing is asked about it", async () => {
  const out = outDir();
  const { index, report } = await buildRegistry({
    config,
    listings: [{ file: "hello@example.com.json", listing: listing({ delisted: true }) }],
    blocked: {},
    candidates: async () => {
      throw new Error("asked for releases");
    },
    out,
  });
  assert.equal(index.extensions.length, 0);
  assert.deepEqual(report[0].problems, ["Delisted by its owner."]);
  assert.equal(existsSync(join(out, "updates/hello@example.com.json")), false);
});

test("an extension blocked in every version is not even downloaded", async () => {
  const { index, report } = await buildRegistry({
    config,
    listings: [{ file: "hello@example.com.json", listing: listing() }],
    blocked: { "hello@example.com": { versionRanges: ["*"], reason: "Malware." } },
    candidates: async () => {
      throw new Error("asked for releases");
    },
    out: outDir(),
  });
  assert.equal(index.extensions.length, 0);
  assert.deepEqual(report[0].problems, ["Blocked: Malware."]);
});

test("only the newest versions are kept", async () => {
  const { index } = await buildRegistry({
    config: { ...config, versionsKept: 2 },
    listings: [{ file: "hello@example.com.json", listing: listing() }],
    blocked: {},
    candidates: async () => ["1.3", "1.2", "1.1", "1.0"].map((v) => release(`v${v}`, xpiAt(v))),
    out: outDir(),
  });
  assert.deepEqual(index.extensions[0].versions.map((v) => v.version), ["1.3", "1.2"]);
});

test("a run looks at no more releases than it keeps and five more, passing or failing", async () => {
  let loaded = 0;
  const failing = xpi({ files: { "bootstrap.js": null } });
  const lines = [];
  const { index, report } = await buildRegistry({
    config: { ...config, versionsKept: 2 },
    listings: [{ file: "hello@example.com.json", listing: listing() }],
    blocked: {},
    candidates: async () => [
      ...Array.from({ length: 20 }, (_, i) =>
        release(`v2.${19 - i}`, null, {
          load: async () => {
            loaded++;
            return failing;
          },
        }),
      ),
      release("v1.0.0", xpiAt("1.0.0")),
    ],
    out: outDir(),
    log: (line) => lines.push(line),
  });
  assert.equal(loaded, 7);
  assert.equal(index.extensions.length, 0);
  assert.equal(report[0].rejected.length, 7);
  assert.match(report[0].problems[0], /among the newest 7, which are all a publish looks at/);
  // Said before the build, so that one that runs out of time shows where it was.
  assert.deepEqual(lines, ["Building hello@example.com"]);
});

test("a broken listing or an unreachable repository lists nothing", async () => {
  const { index, report } = await buildRegistry({
    config,
    listings: [
      { file: "hello@example.com.json", listing: listing({ repo: "not a repo" }) },
      { file: "other@example.com.json", listing: listing({ id: "other@example.com" }) },
      { file: "broken.json", listing: null },
    ],
    blocked: {},
    candidates: async () => {
      throw new Error("someone/hello was not found, or is not public");
    },
    out: outDir(),
  });
  assert.equal(index.extensions.length, 0);
  assert.match(report[0].problems[0], /"repo"/);
  assert.match(report[1].problems[0], /not found/);
  assert.match(report[2].problems[0], /JSON object/);
});

test("one extension that breaks the build leaves the others listed", async () => {
  const out = outDir();
  const other = listing({ id: "other@example.com" });
  const proto = listing({ id: "constructor" });
  const { index, report } = await buildRegistry({
    config,
    listings: [
      { file: "hello@example.com.json", listing: listing() },
      { file: "other@example.com.json", listing: other },
      { file: "constructor.json", listing: proto },
    ],
    // An id named after an Object.prototype member finds no block.
    blocked: Object.create(null),
    candidates: async (l) =>
      l.id === "hello@example.com"
        ? [
            // A manifest that is not an object, and a version too long for a file name.
            release("v3", xpi({ files: { "manifest.json": "null" } })),
            release("v2", xpiAt(`1a${"b".repeat(300)}`)),
            release("v1", xpiAt("1.0.0")),
          ]
        : [release("v1", xpi({ manifest: manifest({ zotero: { id: l.id, update_url: `https://registry.test/updates/${l.id}.json` } }) }))],
    verifyPublisher: async (l) => {
      if (l.id === "other@example.com") {
        throw new Error("the publisher check fell over");
      }
      return { verified: false, domain: null, problem: null };
    },
    out,
  });
  assert.deepEqual(index.extensions.map((e) => e.id).sort(), ["constructor", "hello@example.com"]);
  const [hello, broken] = report;
  assert.deepEqual(hello.versions, ["1.0.0"]);
  assert.match(hello.rejected[0].reasons[0], /JSON object/);
  assert.match(hello.rejected[1].reasons[0], /not a valid version/);
  assert.equal(broken.listed, false);
  assert.match(broken.problems[0], /could not be built: the publisher check fell over/);
  // Nothing of the broken extension is served.
  assert.equal(existsSync(join(out, "updates/other@example.com.json")), false);
  assert.equal(existsSync(join(out, "files/other@example.com")), false);
  assert.equal(blockedReason({}, "constructor", "1.0"), null);
});

test("when GitHub cannot be asked, the build stops instead of publishing less", async () => {
  const unanswered = new Error("GitHub answered 502 for /repos/someone/hello/releases");
  unanswered.fatal = true;
  await assert.rejects(
    buildRegistry({
      config,
      listings: [{ file: "hello@example.com.json", listing: listing() }],
      blocked: {},
      candidates: async () => {
        throw unanswered;
      },
      out: outDir(),
    }),
    unanswered,
  );

  // The same when the newest release cannot be downloaded: publishing the
  // older ones alone would hold back what may be a security fix.
  const undownloaded = new Error("The download was answered 502 for https://example.com/v1.1.0.xpi");
  undownloaded.fatal = true;
  await assert.rejects(
    buildRegistry({
      config,
      listings: [{ file: "hello@example.com.json", listing: listing() }],
      blocked: {},
      candidates: async () => [
        release("v1.1.0", null, {
          load: async () => {
            throw undownloaded;
          },
        }),
        release("v1.0.0", xpiAt("1.0.0")),
      ],
      out: outDir(),
    }),
    undownloaded,
  );
});

test("an extension too large for the index is left out", async () => {
  // As many web addresses as a version keeps, as long as host names go, in
  // each of twenty versions
  const large = (v) =>
    xpi({
      manifest: manifest({ version: `1.${v}` }),
      files: {
        "content/a.js": Array.from({ length: 100 }, (_, i) => `fetch("https://${"h".repeat(230)}${i}.v${v}.example.net/");`).join("\n"),
      },
    });
  const other = listing({ id: "other@example.com" });
  const out = outDir();
  const { index, report } = await buildRegistry({
    config: { ...config, versionsKept: 20 },
    listings: [
      { file: "hello@example.com.json", listing: listing() },
      { file: "other@example.com.json", listing: other },
    ],
    blocked: {},
    candidates: async (l) =>
      l.id === "hello@example.com"
        ? Array.from({ length: 20 }, (_, v) => release(`v1.${v}`, large(v)))
        : [release("v1", xpi({ manifest: manifest({ zotero: { id: l.id, update_url: `https://registry.test/updates/${l.id}.json` } }) }))],
    out,
  });
  assert.deepEqual(index.extensions.map((e) => e.id), ["other@example.com"]);
  assert.equal(report[0].listed, false);
  assert.match(report[0].problems[0], /could not be built: its entry in index.json would take \d+ KB, and one extension may take 64 KB/);
  assert.equal(existsSync(join(out, "updates/hello@example.com.json")), false);
  assert.equal(existsSync(join(out, "files/hello@example.com")), false);
});

test("an index too large leaves out its largest extensions, not the blocks", async () => {
  // Entries of three sizes, by how many web addresses each version names
  const hosts = { "large@example.com": 40, "medium@example.com": 20, "small@example.com": 0 };
  const sized = (id) =>
    xpi({
      manifest: manifest({ zotero: { id, update_url: `https://registry.test/updates/${id}.json` } }),
      files: {
        "content/a.js": Array.from({ length: hosts[id] }, (_, i) => `fetch("https://${"h".repeat(60)}${i}.example.net/");`).join("\n"),
      },
    });
  const build = (blocked, out = outDir()) =>
    buildRegistry({
      config,
      listings: Object.keys(hosts).map((id) => ({ file: `${id}.json`, listing: listing({ id }) })),
      blocked,
      candidates: async (l) => [release("v1", sized(l.id))],
      out,
    });
  const size = (value) => Buffer.byteLength(JSON.stringify(value));

  // A block whose reason fills the index to just over 8 MB: by less than the
  // largest extension takes, and more than the next.
  const { index: all } = await build({});
  const entry = (id) => size(all.extensions.find((e) => e.id === id));
  const block = (reason) => ({ "x@example.com": { versionRanges: ["*"], reason } });
  const room = 8 * 1024 * 1024 - size({ ...all, blocked: block("") });
  const blocked = block("x".repeat(room + entry("medium@example.com")));

  const out = outDir();
  const { index, report } = await build(blocked, out);
  assert.deepEqual(index.extensions.map((e) => e.id), ["medium@example.com", "small@example.com"]);
  assert.deepEqual(index.blocked, blocked);
  const bytes = readFileSync(join(out, "index.json"));
  assert.ok(bytes.length <= 8 * 1024 * 1024);
  assert.deepEqual(JSON.parse(bytes).extensions.map((e) => e.id), ["medium@example.com", "small@example.com"]);
  assert.deepEqual(report.map((e) => e.listed), [false, true, true]);
  assert.deepEqual(report[0].versions, []);
  assert.match(
    report[0].problems[0],
    /^Left out: index.json would be over the 8.0 MB Paperly can be relied on to download, and at \d+ KB this was the largest extension in it\.$/,
  );
  assert.equal(existsSync(join(out, "updates/large@example.com.json")), false);
  assert.equal(existsSync(join(out, "files/large@example.com")), false);
  assert.equal(existsSync(join(out, "updates/medium@example.com.json")), true);

  // Blocks too large on their own stop the build: they are not to be left out.
  await assert.rejects(
    build(block("x".repeat(9 * 1024 * 1024))),
    (e) =>
      e.fatal &&
      /^index.json would take 9.0 MB with no extension listed, over the 8.0 MB .*; blocked.json must be made smaller\.$/.test(e.message),
  );
});

test("blocked.json is checked", () => {
  assert.deepEqual(validateBlocked({}), []);
  assert.equal(validateBlocked({ x: { versionRanges: [], reason: "" } }).length, 2);
  assert.equal(validateBlocked([]).length, 1);
  assert.deepEqual(validateBlocked({ x: { versionRanges: ["*"], reason: "Malware.", global: true } }), []);
  assert.match(validateBlocked({ x: { versionRanges: ["*"], reason: "Malware.", global: "yes" } })[0], /"global" must be/);
});

test("the public key can be recovered from the private key", async () => {
  const keys = await generateKeys();
  assert.equal(await publicKeyOf(keys.privateKey), keys.publicKey);
});

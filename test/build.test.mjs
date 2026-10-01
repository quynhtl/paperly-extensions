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
});

test("blocked.json is checked", () => {
  assert.deepEqual(validateBlocked({}), []);
  assert.equal(validateBlocked({ x: { versionRanges: [], reason: "" } }).length, 2);
  assert.equal(validateBlocked([]).length, 1);
});

test("the public key can be recovered from the private key", async () => {
  const keys = await generateKeys();
  assert.equal(await publicKeyOf(keys.privateKey), keys.publicKey);
});

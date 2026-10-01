import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildXpi, MARKETPLACE } from "../template/scripts/build.mjs";
import { inspectXpi } from "../scripts/lib/inspect.mjs";
import { loadConfig, slug } from "../scripts/lib/config.mjs";

const SRC = new URL("../template/src/", import.meta.url).pathname;

test("the template builds, and passes the marketplace's checks with nothing to report", () => {
  const config = loadConfig();
  assert.equal(MARKETPLACE, config.baseURL, "the template must point at the same marketplace as registry.json");

  const { name, data, manifest, warnings } = buildXpi(SRC);
  const id = manifest.applications.zotero.id;
  assert.equal(name, `${slug(id)}-${manifest.version}.xpi`);
  assert.match(warnings[0], /still hello-paperly@your-login\.github\.io/);

  const listing = { id, name: "Hello Paperly", description: "x", repo: "your-name/hello-paperly", declares: {} };
  const result = inspectXpi(data, { listing, config });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.icon.type, "image/svg+xml");
});

test("every place that names the marketplace names the one in registry.json", () => {
  // Changing the address in one place and not the others breaks publishing,
  // or has developers ship update URLs the checks refuse.
  const { baseURL } = loadConfig();
  const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
  assert.ok(manifest.applications.zotero.update_url.startsWith(`${baseURL}updates/`), "template/src/manifest.json");
  for (const file of ["README.md", "docs/getting-started.md"]) {
    assert.ok(readFileSync(new URL(`../${file}`, import.meta.url), "utf8").includes(`${baseURL}updates/`), file);
  }
});

test("the template builds for a local test marketplace without its source changing", () => {
  const local = "http://127.0.0.1:8765/";
  const { data, manifest, warnings } = buildXpi(SRC, { marketplace: local });
  const id = manifest.applications.zotero.id;
  assert.match(manifest.applications.zotero.update_url, /^https:\/\/quynhtl/);
  assert.ok(warnings.some((w) => /test marketplace at http:\/\/127\.0\.0\.1:8765\//.test(w)));

  const listing = { id, name: "Hello Paperly", description: "x", repo: "your-name/hello-paperly", repoId: 1, declares: {} };
  const result = inspectXpi(data, { listing, config: { ...loadConfig(), baseURL: local } });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.applications.zotero.update_url, `${local}updates/${slug(id)}.json`);
});

test("the same source makes the same bytes", () => {
  assert.deepEqual(buildXpi(SRC).data, buildXpi(SRC).data);
});

test("the build refuses what the marketplace would", () => {
  const dir = mkdtempSync(join(tmpdir(), "paperly-template-"));
  cpSync(SRC, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  manifest.applications.zotero.update_url = "https://example.com/updates.json";
  delete manifest.applications.zotero.strict_max_version;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => buildXpi(dir), (e) => /update_url" must be https:\/\/quynhtl/.test(e.message) && /strict_max_version/.test(e.message));
});

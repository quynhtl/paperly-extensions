// Fixtures: a small, valid extension that each test bends one way.
import { writeZip } from "../scripts/lib/zip.mjs";

export const config = {
  baseURL: "https://registry.test/",
  appVersion: "11.0",
  officialOwners: ["paperly"],
  versionsKept: 5,
  maxXpiBytes: 1024 * 1024,
};

export function listing(overrides = {}) {
  return {
    id: "hello@example.com",
    name: "Hello",
    description: "Says hello.",
    repo: "someone/hello",
    repoId: 101,
    declares: {},
    ...overrides,
  };
}

export function manifest(overrides = {}) {
  const { zotero, ...rest } = overrides;
  return {
    manifest_version: 2,
    name: "Hello",
    version: "1.0.0",
    icons: { 48: "icon-48.png", 96: "icon-96.png" },
    applications: {
      zotero: {
        id: "hello@example.com",
        update_url: "https://registry.test/updates/hello@example.com.json",
        strict_min_version: "9.0",
        strict_max_version: "11.*",
        ...zotero,
      },
    },
    ...rest,
  };
}

/** An .xpi from a manifest and extra files; `null` for a file leaves it out. */
export function xpi({ manifest: m = manifest(), files = {} } = {}) {
  const all = {
    "manifest.json": JSON.stringify(m),
    "bootstrap.js": "function startup() {}\nfunction shutdown() {}\n",
    "icon-48.png": Buffer.from("png48"),
    "icon-96.png": Buffer.from("png96"),
    ...files,
  };
  return writeZip(
    Object.entries(all)
      .filter(([, data]) => data !== null)
      .map(([name, data]) => ({ name, data })),
  );
}

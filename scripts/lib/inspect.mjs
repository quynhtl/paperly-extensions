// The automated check every version goes through before it is published.
//
// An extension runs with all of Paperly's access, so nothing here can prove
// one is safe. What the check can do is refuse the things the policy forbids
// outright (remote code, obfuscation, updates that skip the marketplace), and
// compare what the code visibly uses with what the listing declares, so that
// people see the difference before they install.
//
// Three levels: an "error" keeps the version out of the marketplace; a
// "warning" is shown next to the install button; a "notice" is shown in the
// details.
import { nameInMessage, readZip, ZipError } from "./zip.mjs";
import { updateURL } from "./config.mjs";
import { isCompatible } from "./version.mjs";

/** Files whose text is scanned: code, and markup that can hold code. */
const SCANNED = /\.(m?js|cjs|jsm|jsx|html?|xhtml|xul|svg)$/i;

/**
 * What the code was seen to use, keyed like the listing's `declares`. Each
 * pattern is a name the platform gives that ability; reading files is left
 * out on purpose, because every extension reads its own.
 */
export const USES = [
  {
    key: "cookies",
    does: "reads cookies and sign-ins kept by Paperly",
    patterns: [/\bServices\.cookies\b/, /\bnsICookieManager\b/, /@mozilla\.org\/cookie(?:manager|Service);/],
  },
  {
    key: "passwords",
    does: "reads saved passwords or keys",
    patterns: [
      /\bServices\.logins\b/,
      /\bnsILoginManager\b/,
      /@mozilla\.org\/login-manager;/,
      /\bOSKeyStore\b/,
      /\bZotero\.Sync\.Data\.Local\.getAPIKey\b/,
    ],
  },
  {
    key: "programs",
    does: "starts other programs",
    patterns: [/\bSubprocess\b/, /\bnsIProcess\b/, /@mozilla\.org\/process\/util;/, /\bZotero\.Utilities\.Internal\.exec\b/],
  },
  {
    key: "clipboard",
    does: "uses the clipboard",
    patterns: [
      /\bnsIClipboard(?:Helper)?\b/,
      /@mozilla\.org\/widget\/clipboard(?:helper)?;/,
      /\bnavigator\.clipboard\b/,
      /\bcopyTextToClipboard\b/,
    ],
  },
  {
    key: "files",
    does: "writes files or asks for them",
    patterns: [
      /\bnsIFilePicker\b/,
      /@mozilla\.org\/filepicker;/,
      /\bIOUtils\.(?:write|writeUTF8|writeJSON|remove|move|copy|makeDirectory|setPermissions)\b/,
      /\bOS\.File\.(?:write|writeAtomic|remove|move|copy|makeDir|removeDir)\b/,
      /\bZotero\.File\.putContents(?:Async)?\b/,
    ],
  },
];

/** Loading code from the network: refused outright. */
const REMOTE_CODE = [
  /\bloadSubScript(?:WithOptions)?\(\s*["'`]https?:/,
  /\bimportESModule\(\s*["'`]https?:/,
  /\bimport\(\s*["'`]https?:/,
  /\bimportScripts\(\s*["'`]https?:/,
];

/**
 * Where a <script> tag with an http(s) src starts, or -1. A pattern such as
 * /<script\b[^>]*\bsrc=/ goes over the rest of the text again at every
 * "<script" that no ">" follows, so a few megabytes of them would take hours;
 * this goes over the text once, remembering whether a <script tag is open.
 */
function remoteScriptTag(text) {
  let open = -1;
  for (const m of text.matchAll(/<script\b|>|\bsrc\s*=\s*["']https?:/gi)) {
    if (m[0] === ">") {
      open = -1;
    } else if (m[0][0] === "<") {
      if (open < 0) {
        open = m.index;
      }
    } else if (open >= 0) {
      return open;
    }
  }
  return -1;
}

/**
 * The most text of one file that is scanned. Every pattern runs over all of
 * it, so this bounds the time one release can take; a larger file of code is
 * refused, since what was not read cannot be vouched for.
 */
const MAX_SCANNED_BYTES = 8 * 1024 * 1024;

/** Building code from text at run time. Bundled libraries do it harmlessly, so it is only noted. */
const DYNAMIC_CODE = [/\beval\s*\(/, /\bnew\s+Function\s*\(/];

/** The signature identifiers of javascript-obfuscator and its relatives. */
const OBFUSCATED = /\b_0x[0-9a-f]{4,6}\b/g;
const OBFUSCATED_MIN = 25;

/** Hosts that appear in code as names, not as places it connects to. */
const NOT_CONTACTED = new Set([
  "www.w3.org",
  "w3.org",
  "www.mozilla.org",
  "purl.org",
  "ns.adobe.com",
  "schemas.xmlsoap.org",
  "schemas.openxmlformats.org",
  "schemas.microsoft.com",
  "json-schema.org",
  "xmlns.com",
  "example.com",
  "www.example.com",
  "example.org",
  "localhost",
]);

const URL_IN_STRING = /["'`](?:https?|wss?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

/** The longest host name DNS allows; anything longer is no place code connects to. */
const MAX_HOST_LENGTH = 253;

/**
 * The most web addresses kept for one version, which are published with it;
 * the rest are counted. Code can mention millions, and each would be in the
 * index Paperly downloads.
 */
const MAX_HOSTS = 100;

/**
 * The most findings kept for one version, for the same reason, and because
 * every error is written in the report: past this, the last one kept says
 * how many more there were.
 */
const MAX_FINDINGS = 50;

/**
 * Icons the marketplace re-hosts: PNG and JPEG only. It serves them on its own
 * web address, where an SVG opened directly would run any script in it on
 * that site; telling a harmless SVG from a harmful one took one pattern after
 * another, each with a way around it, while a PNG or JPEG cannot run anything.
 * Each must start the way its format does, so no other file can pass for one.
 */
const ICON_FORMATS = [
  { type: "image/png", extensions: ["png"], magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", extensions: ["jpg", "jpeg"], magic: [0xff, 0xd8, 0xff] },
];

/** An icon for a 96px button needs a few kilobytes; nothing near this. */
const MAX_ICON_BYTES = 512 * 1024;

function iconFormat(path) {
  const extension = path.split(".").pop().toLowerCase();
  return ICON_FORMATS.find((f) => f.extensions.includes(extension)) || null;
}

const MAX_VERSION_LENGTH = 64;

const VERSION = /^\d+(?:\.\d+){0,3}(?:[a-z][a-z0-9.+-]*)?$/i;

/** strict_min_version and strict_max_version, where a part may be "*", as in 11.*. */
const APP_VERSION = /^(?:\d+|\*)(?:\.(?:\d+|\*)){0,3}(?:[a-z][a-z0-9.+-]*)?$/i;

// A version names a file; it and the strict versions are copied into the
// index and every update manifest; and Gecko reads each number as an int32.
// So all are kept short, with no number longer than 9 digits.
function validVersion(version, pattern) {
  return typeof version === "string" && version.length <= MAX_VERSION_LENGTH && !/\d{10}/.test(version) && pattern.test(version);
}

function hostCovered(host, declared) {
  return declared.some((d) => host === d || host.endsWith(`.${d}`));
}

function snippetAround(text, index) {
  return text
    .slice(Math.max(0, index - 30), index + 60)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The icon to show: of the PNG and JPEG icons the manifest names, the
 * smallest of at least 64px, else the largest. Returns { path } for that one,
 * or { skipped } naming an icon in a format the marketplace does not show.
 */
function pickIcon(manifest) {
  const icons = manifest.icons && typeof manifest.icons === "object" ? manifest.icons : {};
  const entries = Object.keys(icons)
    .map(Number)
    .filter((n) => Number.isFinite(n) && typeof icons[n] === "string")
    .sort((a, b) => a - b)
    .map((n) => ({ size: n, path: icons[n].replace(/^\.?\//, "") }));
  const raster = entries.filter((e) => iconFormat(e.path));
  if (!raster.length) {
    return entries.length ? { skipped: entries[entries.length - 1].path } : null;
  }
  return { path: (raster.find((e) => e.size >= 64) ?? raster[raster.length - 1]).path };
}

/**
 * Checks one .xpi against its listing. `config` is registry.json.
 */
export function inspectXpi(buffer, { listing, config }) {
  const findings = [];
  let failed = false;
  let omitted = 0;
  const add = (finding) => (findings.length < MAX_FINDINGS ? findings.push(finding) : omitted++);
  const error = (code, message, file) => {
    failed = true;
    add({ level: "error", code, message, ...(file && { file }) });
  };
  const warning = (code, message) => add({ level: "warning", code, message });
  const notice = (code, message) => add({ level: "notice", code, message });
  const result = {
    ok: false,
    findings,
    manifest: null,
    name: null,
    version: null,
    minAppVersion: null,
    maxAppVersion: null,
    icon: null,
    detected: { uses: [], hosts: [], moreHosts: 0 },
  };

  if (buffer.length > config.maxXpiBytes) {
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    error("too-large", `The .xpi is ${mb(buffer.length)} MB; the limit is ${mb(config.maxXpiBytes)} MB.`);
    return result;
  }

  let zip;
  try {
    zip = readZip(buffer);
  } catch (e) {
    error("not-a-zip", `The file is not a usable .xpi: ${e instanceof ZipError ? e.message : "unreadable"}.`);
    return result;
  }

  // The manifest.
  let manifest;
  try {
    const raw = zip.read("manifest.json");
    if (!raw) {
      error("manifest-missing", "There is no manifest.json at the top of the .xpi.");
      return result;
    }
    manifest = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    error("manifest-invalid", `manifest.json cannot be read: ${e.message}`);
    return result;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    error("manifest-invalid", "manifest.json must hold a JSON object.");
    return result;
  }
  result.manifest = manifest;
  if (manifest.manifest_version !== 2) {
    error("manifest-version", "manifest_version must be 2.");
  }
  result.name = typeof manifest.name === "string" ? manifest.name : null;
  if (!result.name) {
    error("name-missing", 'manifest.json has no "name".');
  }
  const version = manifest.version;
  if (!validVersion(version, VERSION)) {
    error(
      "version-invalid",
      `"${String(version).slice(0, MAX_VERSION_LENGTH)}" is not a valid version: up to ${MAX_VERSION_LENGTH} characters, such as 1.2.3, with no number longer than 9 digits.`,
    );
  } else {
    result.version = version;
  }

  const zotero = manifest.applications?.zotero;
  if (!zotero || typeof zotero !== "object") {
    error("applications-missing", 'manifest.json needs an "applications": { "zotero": { ... } } block.');
  } else {
    if (zotero.id !== listing.id) {
      error("id-mismatch", `The manifest's id is "${nameInMessage(String(zotero.id))}", but the listing's is "${listing.id}".`);
    }
    const expected = updateURL(config, listing.id);
    if (zotero.update_url !== expected) {
      error(
        "update-url",
        `applications.zotero.update_url must be ${expected}, so that every update comes through the marketplace.`,
      );
    }
    if (typeof zotero.strict_min_version !== "string" || typeof zotero.strict_max_version !== "string") {
      error("compat-missing", "applications.zotero needs strict_min_version and strict_max_version.");
    } else if (!validVersion(zotero.strict_min_version, APP_VERSION) || !validVersion(zotero.strict_max_version, APP_VERSION)) {
      for (const key of ["strict_min_version", "strict_max_version"]) {
        if (!validVersion(zotero[key], APP_VERSION)) {
          error(
            "compat-invalid",
            `${key} "${zotero[key].slice(0, MAX_VERSION_LENGTH)}" is not a valid version: up to ${MAX_VERSION_LENGTH} characters, such as 10.0 or 11.*, with no number longer than 9 digits.`,
          );
        }
      }
    } else {
      result.minAppVersion = zotero.strict_min_version;
      result.maxAppVersion = zotero.strict_max_version;
      if (!isCompatible(config.appVersion, zotero.strict_min_version, zotero.strict_max_version)) {
        warning(
          "incompatible",
          `Runs in Paperly ${zotero.strict_min_version} to ${zotero.strict_max_version}, not in ${config.appVersion}.`,
        );
      }
    }
  }
  if (!zip.entries.has("bootstrap.js")) {
    error("bootstrap-missing", "There is no bootstrap.js, so Paperly would never start the extension.");
  }

  // The code.
  const uses = new Set();
  const hosts = new Set();
  let dynamic = null;
  for (const name of zip.names) {
    if (!SCANNED.test(name)) {
      continue;
    }
    const size = zip.entries.get(name).size;
    if (size > MAX_SCANNED_BYTES) {
      const mb = (n) => (n / 1024 / 1024).toFixed(1);
      error("file-too-large", `${nameInMessage(name)} is ${mb(size)} MB; a file of code over ${mb(MAX_SCANNED_BYTES)} MB cannot be checked.`, name);
      continue;
    }
    let text;
    try {
      text = zip.read(name).toString("utf8");
    } catch (e) {
      // The version is refused either way, and an archive that breaks one
      // limit would only cost time on the rest.
      error("unreadable", `${nameInMessage(name)} cannot be read: ${e.message}`, name);
      break;
    }
    for (const pattern of REMOTE_CODE) {
      const m = pattern.exec(text);
      if (m) {
        error("remote-code", `${nameInMessage(name)} loads code from the internet: ${snippetAround(text, m.index)}`, name);
      }
    }
    const script = remoteScriptTag(text);
    if (script >= 0) {
      error("remote-code", `${nameInMessage(name)} loads code from the internet: ${snippetAround(text, script)}`, name);
    }
    const obfuscated = text.match(OBFUSCATED);
    if (obfuscated && obfuscated.length >= OBFUSCATED_MIN) {
      error("obfuscated", `${nameInMessage(name)} looks deliberately obfuscated (${obfuscated.length} _0x… names).`, name);
    }
    if (!dynamic && DYNAMIC_CODE.some((p) => p.test(text))) {
      dynamic = name;
    }
    for (const use of USES) {
      if (!uses.has(use.key) && use.patterns.some((p) => p.test(text))) {
        uses.add(use.key);
      }
    }
    for (const m of text.matchAll(URL_IN_STRING)) {
      const host = m[1].toLowerCase();
      if (host.length <= MAX_HOST_LENGTH && !NOT_CONTACTED.has(host) && !/^(?:127\.|0\.0\.0\.0$)/.test(host)) {
        hosts.add(host);
      }
    }
  }
  const allHosts = [...hosts].sort();
  result.detected = {
    uses: [...uses].sort(),
    hosts: allHosts.slice(0, MAX_HOSTS),
    moreHosts: Math.max(0, allHosts.length - MAX_HOSTS),
  };

  const declares = listing.declares || {};
  for (const use of USES) {
    if (uses.has(use.key) && declares[use.key] !== true) {
      warning(`undeclared-${use.key}`, `The code ${use.does}, but the listing does not say so.`);
    }
  }
  const undeclaredHosts = allHosts.filter((h) => !hostCovered(h, declares.network || []));
  if (undeclaredHosts.length) {
    const shown = undeclaredHosts.slice(0, 12).join(", ");
    const more = undeclaredHosts.length > 12 ? ` and ${undeclaredHosts.length - 12} more` : "";
    notice("undeclared-hosts", `The code mentions web addresses the listing does not declare: ${shown}${more}.`);
  }
  if (declares.sendsContent && !listing.privacyPolicy) {
    warning("no-privacy-policy", "Sends content to web services, but gives no privacy policy.");
  }
  if (dynamic) {
    notice("dynamic-code", `${nameInMessage(dynamic)} builds code from text while running (eval or new Function).`);
  }

  // The icon, for the marketplace to show.
  const icon = pickIcon(manifest);
  if (icon?.skipped) {
    notice(
      "icon-format",
      `The marketplace shows PNG and JPEG icons only, so ${nameInMessage(icon.skipped)} is not shown. Add a PNG to the icons in manifest.json.`,
    );
  } else if (icon) {
    const format = iconFormat(icon.path);
    // The size the archive states, which zip.read holds the data to
    const size = zip.entries.get(icon.path)?.size ?? 0;
    let data = null;
    if (size <= MAX_ICON_BYTES) {
      try {
        data = zip.read(icon.path);
      } catch {
        data = null;
      }
    }
    if (size > MAX_ICON_BYTES) {
      notice("icon-too-large", `The icon ${nameInMessage(icon.path)} is ${Math.ceil(size / 1024)} KB; the marketplace shows icons up to ${MAX_ICON_BYTES / 1024} KB.`);
    } else if (!data) {
      notice("icon-missing", `The icon ${nameInMessage(icon.path)} is not in the .xpi.`);
    } else if (!format.magic.every((byte, i) => data[i] === byte)) {
      notice("icon-format", `The icon ${nameInMessage(icon.path)} is not a ${format.type === "image/png" ? "PNG" : "JPEG"} file, whatever its name says, so it is not shown.`);
    } else {
      result.icon = { path: icon.path, type: format.type, data };
    }
  }

  if (omitted) {
    // The last one kept makes way for the count: an error when the version
    // is refused, so that the reasons given for refusing it include it.
    findings[MAX_FINDINGS - 1] = {
      level: failed ? "error" : "notice",
      code: "more-findings",
      message: `And ${omitted + 1} more findings, not listed.`,
    };
  }
  result.ok = !failed;
  return result;
}

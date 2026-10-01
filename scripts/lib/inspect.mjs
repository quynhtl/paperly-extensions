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
import { readZip, ZipError } from "./zip.mjs";
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

const ICON_TYPES = { png: "image/png", svg: "image/svg+xml", jpg: "image/jpeg", jpeg: "image/jpeg" };

/**
 * What makes an SVG more than a picture: scripts, event handlers, embedded
 * HTML, and links anywhere but inside itself. Inside Paperly an icon is shown
 * as an image, where none of it runs, but the marketplace serves the icon on
 * its own web address too, and opened there it would run on that site.
 */
const SVG_UNSAFE = [
  /<(?:[\w.-]+:)?script\b/i,
  /\bon[a-z]+\s*=/i,
  /<(?:[\w.-]+:)?foreignObject\b/i,
  /javascript:/i,
  /\bhref\s*=(?!\s*["']\s*#)/i,
];

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function unsafeSVG(data) {
  let text;
  try {
    text = UTF8.decode(data);
  } catch {
    // Another encoding (UTF-16, say) would hide all of the above from the patterns.
    return true;
  }
  return text.includes("\0") || SVG_UNSAFE.some((p) => p.test(text));
}

const MAX_VERSION_LENGTH = 64;

function hostCovered(host, declared) {
  return declared.some((d) => host === d || host.endsWith(`.${d}`));
}

function snippetAround(text, index) {
  return text
    .slice(Math.max(0, index - 30), index + 60)
    .replace(/\s+/g, " ")
    .trim();
}

function pickIcon(manifest) {
  const icons = manifest.icons && typeof manifest.icons === "object" ? manifest.icons : {};
  const sizes = Object.keys(icons)
    .map(Number)
    .filter((n) => Number.isFinite(n) && typeof icons[n] === "string")
    .sort((a, b) => a - b);
  if (!sizes.length) {
    return null;
  }
  const size = sizes.find((n) => n >= 64) ?? sizes[sizes.length - 1];
  return icons[size].replace(/^\.?\//, "");
}

/**
 * Checks one .xpi against its listing. `config` is registry.json.
 */
export function inspectXpi(buffer, { listing, config }) {
  const findings = [];
  const error = (code, message, file) => findings.push({ level: "error", code, message, ...(file && { file }) });
  const warning = (code, message) => findings.push({ level: "warning", code, message });
  const notice = (code, message) => findings.push({ level: "notice", code, message });
  const result = {
    ok: false,
    findings,
    manifest: null,
    name: null,
    version: null,
    minAppVersion: null,
    maxAppVersion: null,
    icon: null,
    detected: { uses: [], hosts: [] },
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
  // The version names a file, and Gecko reads each number as an int32, so
  // both are kept short.
  const version = manifest.version;
  if (
    typeof version !== "string" ||
    version.length > MAX_VERSION_LENGTH ||
    /\d{10}/.test(version) ||
    !/^\d+(?:\.\d+){0,3}(?:[a-z][a-z0-9.+-]*)?$/i.test(version)
  ) {
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
      error("id-mismatch", `The manifest's id is "${zotero.id}", but the listing's is "${listing.id}".`);
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
      error("file-too-large", `${name} is ${mb(size)} MB; a file of code over ${mb(MAX_SCANNED_BYTES)} MB cannot be checked.`, name);
      continue;
    }
    let text;
    try {
      text = zip.read(name).toString("utf8");
    } catch (e) {
      // The version is refused either way, and an archive that breaks one
      // limit would only cost time on the rest.
      error("unreadable", `${name} cannot be read: ${e.message}`, name);
      break;
    }
    for (const pattern of REMOTE_CODE) {
      const m = pattern.exec(text);
      if (m) {
        error("remote-code", `${name} loads code from the internet: ${snippetAround(text, m.index)}`, name);
      }
    }
    const script = remoteScriptTag(text);
    if (script >= 0) {
      error("remote-code", `${name} loads code from the internet: ${snippetAround(text, script)}`, name);
    }
    const obfuscated = text.match(OBFUSCATED);
    if (obfuscated && obfuscated.length >= OBFUSCATED_MIN) {
      error("obfuscated", `${name} looks deliberately obfuscated (${obfuscated.length} _0x… names).`, name);
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
      if (!NOT_CONTACTED.has(host) && !/^(?:127\.|0\.0\.0\.0$)/.test(host)) {
        hosts.add(host);
      }
    }
  }
  result.detected = { uses: [...uses].sort(), hosts: [...hosts].sort() };

  const declares = listing.declares || {};
  for (const use of USES) {
    if (uses.has(use.key) && declares[use.key] !== true) {
      warning(`undeclared-${use.key}`, `The code ${use.does}, but the listing does not say so.`);
    }
  }
  const undeclaredHosts = result.detected.hosts.filter((h) => !hostCovered(h, declares.network || []));
  if (undeclaredHosts.length) {
    const shown = undeclaredHosts.slice(0, 12).join(", ");
    const more = undeclaredHosts.length > 12 ? ` and ${undeclaredHosts.length - 12} more` : "";
    notice("undeclared-hosts", `The code mentions web addresses the listing does not declare: ${shown}${more}.`);
  }
  if (declares.sendsContent && !listing.privacyPolicy) {
    warning("no-privacy-policy", "Sends content to web services, but gives no privacy policy.");
  }
  if (dynamic) {
    notice("dynamic-code", `${dynamic} builds code from text while running (eval or new Function).`);
  }

  // The icon, for the marketplace to show.
  const iconPath = pickIcon(manifest);
  if (iconPath) {
    const type = ICON_TYPES[iconPath.split(".").pop().toLowerCase()];
    let data = null;
    try {
      data = type ? zip.read(iconPath) : null;
    } catch {
      data = null;
    }
    if (data && type === "image/svg+xml" && unsafeSVG(data)) {
      notice("icon-unsafe", `The icon ${iconPath} holds scripts, event handlers, HTML or links, so the marketplace does not show it.`);
    } else if (data) {
      result.icon = { path: iconPath, type, data };
    } else {
      notice("icon-missing", `The icon ${iconPath} is not in the .xpi, or is not a PNG, SVG or JPEG.`);
    }
  }

  result.ok = !findings.some((f) => f.level === "error");
  return result;
}

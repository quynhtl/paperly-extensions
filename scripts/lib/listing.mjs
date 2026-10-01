// The listing file a developer submits: extensions/<id>.json. Anything that
// is not one of the known fields is an error rather than ignored, so a typo in
// `declares` cannot quietly leave something undeclared.
import { slug } from "./config.mjs";

export const CATEGORIES = [
  "ai",
  "reading",
  "writing",
  "citations",
  "notes",
  "organization",
  "import-export",
  "appearance",
  "integration",
  "other",
];

/** What an extension can declare; see POLICY.md. `network` is a list of hosts. */
export const DECLARATIONS = [
  "network",
  "sendsContent",
  "clipboard",
  "files",
  "cookies",
  "passwords",
  "programs",
];

const FIELDS = {
  id: "required",
  name: "required",
  description: "required",
  repo: "required",
  declares: "required",
  publisher: "optional",
  categories: "optional",
  homepage: "optional",
  license: "optional",
  privacyPolicy: "optional",
};

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function isHttpsURL(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Returns the problems with a listing, as sentences for the person who wrote
 * it. `fileName`, when given, must be what the listing's id says it should be.
 */
export function validateListing(listing, { fileName } = {}) {
  const errors = [];
  if (!listing || typeof listing !== "object" || Array.isArray(listing)) {
    return ["The listing must be a JSON object."];
  }

  for (const key of Object.keys(listing)) {
    if (!(key in FIELDS)) {
      errors.push(`Unknown field "${key}".`);
    }
  }
  for (const [key, need] of Object.entries(FIELDS)) {
    if (need === "required" && listing[key] === undefined) {
      errors.push(`"${key}" is required.`);
    }
  }

  const { id, name, description, repo, publisher, categories, homepage, license, privacyPolicy } =
    listing;
  if (id !== undefined) {
    if (typeof id !== "string" || !/^[A-Za-z0-9._@{}+-]{3,80}$/.test(id)) {
      errors.push('"id" must be your manifest\'s applications.zotero.id, such as "my-extension@example.com".');
    } else if (fileName && fileName !== `${slug(id)}.json`) {
      errors.push(`The file must be named ${slug(id)}.json, after its id.`);
    }
  }
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 50 || /[\r\n]/.test(name))) {
    errors.push('"name" must be one line of up to 50 characters.');
  }
  if (description !== undefined && (typeof description !== "string" || !description.trim() || description.length > 250)) {
    errors.push('"description" must be up to 250 characters.');
  }
  if (repo !== undefined && (typeof repo !== "string" || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo))) {
    errors.push('"repo" must be a GitHub repository, as "owner/name".');
  }
  if (publisher !== undefined && (typeof publisher !== "string" || !publisher.trim() || publisher.length > 50)) {
    errors.push('"publisher" must be up to 50 characters.');
  }
  if (categories !== undefined) {
    if (!Array.isArray(categories) || categories.length > 3 || categories.some((c) => !CATEGORIES.includes(c))) {
      errors.push(`"categories" must be up to three of: ${CATEGORIES.join(", ")}.`);
    }
  }
  for (const [key, value] of [["homepage", homepage], ["privacyPolicy", privacyPolicy]]) {
    if (value !== undefined && !isHttpsURL(value)) {
      errors.push(`"${key}" must be an https:// address.`);
    }
  }
  if (license !== undefined && (typeof license !== "string" || !/^[A-Za-z0-9.+()\- ]{1,64}$/.test(license))) {
    errors.push('"license" must be an SPDX identifier, such as "MIT".');
  }

  const { declares } = listing;
  if (declares !== undefined) {
    if (!declares || typeof declares !== "object" || Array.isArray(declares)) {
      errors.push('"declares" must be an object; use {} if the extension does none of it.');
    } else {
      for (const [key, value] of Object.entries(declares)) {
        if (!DECLARATIONS.includes(key)) {
          errors.push(`"declares.${key}" is not something to declare; the keys are ${DECLARATIONS.join(", ")}.`);
        } else if (key === "network") {
          if (!Array.isArray(value) || value.length > 50 || value.some((h) => typeof h !== "string" || !HOST.test(h))) {
            errors.push('"declares.network" must be a list of host names, such as ["api.example.com"].');
          }
        } else if (typeof value !== "boolean") {
          errors.push(`"declares.${key}" must be true or false.`);
        }
      }
    }
  }
  return errors;
}

/** The repository owner, which is who may submit and change a listing. */
export function repoOwner(listing) {
  return String(listing.repo).split("/")[0];
}

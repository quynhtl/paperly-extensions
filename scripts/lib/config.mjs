// Where the marketplace lives, and the names derived from an extension id.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function loadConfig(path = `${ROOT}registry.json`) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!config.baseURL.endsWith("/")) {
    config.baseURL += "/";
  }
  return config;
}

/**
 * The id as it appears in file names and URLs: letters, digits and `._@-`
 * kept, anything else (the braces of a {uuid} id, say) turned into `_`.
 */
export function slug(id) {
  return String(id).replace(/[^A-Za-z0-9._@-]/g, "_");
}

/** The update_url every listed extension must declare. */
export function updateURL(config, id) {
  return `${config.baseURL}updates/${slug(id)}.json`;
}

// Finding an extension's versions: the releases of its public GitHub
// repository that have an .xpi attached.
//
// The build takes GitHub's word on every listing at once, so a failure is
// never mistaken for an answer. What GitHub may answer later (a 5xx, a 429, a
// rate limit) is asked again after a pause; whatever is still unanswered
// throws a GitHubError, which stops the build, so that the site already up
// stays up rather than one missing the extensions GitHub did not answer for.
// Only a repository that is gone is an answer: it lists nothing.

const API = "https://api.github.com";
const RETRIES = 3;
const MAX_WAIT_MS = 60 * 1000;
const PAGE = 100;

/**
 * 404 is a repository that was deleted or made private; 451 one blocked for
 * legal reasons. Either is gone for good, not GitHub failing.
 */
const GONE = new Set([404, 451]);

/** GitHub could not be asked. `fatal` tells the build to stop, not just to skip one extension. */
export class GitHubError extends Error {
  fatal = true;
}

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "paperly-extensions",
    ...(token && { Authorization: `Bearer ${token}` }),
  };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait before asking again, or null when asking again will not help. */
async function retryDelay(response, attempt) {
  const { status, headers: h } = response;
  let limited = status === 429 || status >= 500;
  if (status === 403) {
    // A 403 is worth waiting out only when it is a rate limit.
    const text = await response.text().catch(() => "");
    limited = h.has("retry-after") || h.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(text);
  }
  if (!limited) {
    return null;
  }
  if (h.has("retry-after")) {
    return Number(h.get("retry-after")) * 1000;
  }
  if (h.get("x-ratelimit-remaining") === "0" && h.has("x-ratelimit-reset")) {
    return Number(h.get("x-ratelimit-reset")) * 1000 - Date.now();
  }
  return 1000 * 2 ** attempt;
}

/** A GET of the API that resolves to an answer: a 2xx, or a repository that is gone. */
async function get(path, { token, fetch = globalThis.fetch, wait = pause }) {
  for (let attempt = 0; ; attempt++) {
    let response = null;
    let why;
    try {
      response = await fetch(`${API}${path}`, { headers: headers(token) });
    } catch (e) {
      why = `GitHub could not be reached (${e.message})`;
    }
    if (response && (response.ok || GONE.has(response.status))) {
      return response;
    }
    let delay = 1000 * 2 ** attempt;
    if (response) {
      why = `GitHub answered ${response.status}`;
      delay = await retryDelay(response, attempt);
      await response.body?.cancel().catch(() => {});
    }
    if (delay === null || !(delay <= MAX_WAIT_MS) || attempt >= RETRIES) {
      throw new GitHubError(`${why} for ${path}`);
    }
    await wait(Math.max(0, delay));
  }
}

async function readJSON(response, path) {
  try {
    return await response.json();
  } catch (e) {
    throw new GitHubError(`GitHub's answer for ${path} could not be read: ${e.message}`);
  }
}

function describe(repo, path) {
  if (!Number.isSafeInteger(repo?.id) || typeof repo.full_name !== "string" || !repo.owner) {
    throw new GitHubError(`GitHub's answer for ${path} is not a repository`);
  }
  const { login, id, type } = repo.owner;
  return { id: repo.id, fullName: repo.full_name, owner: { login, id, type } };
}

/**
 * The public repository with this numeric id, as { id, fullName, owner:
 * { login, id, type } }, or null if there is none. The id stays with a
 * repository through renames and transfers and is never given to another, so
 * listings are tied to it rather than to a name someone else could register.
 */
export async function repoById(repoId, { token, fetch, wait } = {}) {
  const path = `/repositories/${Number(repoId)}`;
  const response = await get(path, { token, fetch, wait });
  return GONE.has(response.status) ? null : describe(await readJSON(response, path), path);
}

/** The same for a repository's full name, owner/name: how a developer finds their repository's id. */
export async function repoByName(fullName, { token, fetch, wait } = {}) {
  const path = `/repos/${fullName}`;
  const response = await get(path, { token, fetch, wait });
  return GONE.has(response.status) ? null : describe(await readJSON(response, path), path);
}

/**
 * Published releases of the repository with the numeric id `repoId`, newest
 * first, each with the .xpi to check. Drafts and pre-releases are skipped; so
 * is a release with no .xpi, or with more than one (which would leave it
 * unclear what to publish).
 *
 * Pages are read until `want` published releases are found or there are no
 * more, at most `maxPages` of them: a run of betas marked pre-release must not
 * hide the last stable version.
 */
export async function listReleases(repoId, { token, fetch, wait, want = 1, maxPages = 5 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const path = `/repositories/${Number(repoId)}/releases?per_page=${PAGE}&page=${page}`;
    const response = await get(path, { token, fetch, wait });
    if (GONE.has(response.status)) {
      throw new Error(`Repository ${repoId} was not found, or is not public`);
    }
    const releases = await readJSON(response, path);
    if (!Array.isArray(releases)) {
      throw new GitHubError(`GitHub's answer for ${path} is not a list of releases`);
    }
    for (const release of releases) {
      if (release.draft || release.prerelease) {
        continue;
      }
      const xpis = (release.assets || []).filter((a) => a.name.toLowerCase().endsWith(".xpi"));
      out.push({
        tag: release.tag_name,
        released: release.published_at,
        problem: xpis.length === 0 ? "has no .xpi attached" : xpis.length > 1 ? "has more than one .xpi attached" : null,
        xpi: xpis.length === 1 ? { name: xpis[0].name, url: xpis[0].browser_download_url, size: xpis[0].size } : null,
      });
    }
    if (out.length >= want || releases.length < PAGE) {
      break;
    }
  }
  return out;
}

/**
 * Downloads at most `maxBytes`, whatever the server claims. No token: release
 * assets of a public repository need none, and the download is redirected to
 * another host that should not see one.
 */
export async function download(url, { fetch = globalThis.fetch, maxBytes }) {
  const response = await fetch(url, { headers: { "User-Agent": "paperly-extensions" }, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`The file is larger than ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

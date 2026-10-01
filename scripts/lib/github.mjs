// Finding an extension's versions: the releases of its public GitHub
// repository that have an .xpi attached.
//
// The build takes GitHub's word on every listing at once, so a failure is
// never mistaken for an answer. What GitHub may answer later (a 5xx, a 429, a
// rate limit, a dropped or stalled download) is asked again after a pause;
// whatever is still unanswered throws a GitHubError, which stops the build,
// so that the site already up stays up rather than one missing the
// extensions, or the versions, GitHub did not answer for. Only a repository
// that is gone is an answer: it lists nothing.

const API = "https://api.github.com";
const RETRIES = 3;
const MAX_WAIT_MS = 60 * 1000;
const PAGE = 100;

/**
 * A download is given up on when nothing arrives for this long, or when the
 * whole takes longer than that, and asked again; a connection that stalls
 * would otherwise hold the build until the job's time limit.
 */
const DOWNLOAD_IDLE_MS = 20 * 1000;
const DOWNLOAD_TOTAL_MS = 5 * 60 * 1000;

/**
 * 404 is a repository that was deleted or made private; 451 one blocked for
 * legal reasons. Either is gone for good, not GitHub failing.
 */
const GONE = new Set([404, 451]);

/**
 * Whether a 403's body is GitHub saying it has disabled the repository (for
 * breaking its terms, say): "Repository access blocked", with a `block` that
 * gives the reason. That is gone too. Taken for a failure, one disabled
 * repository would stop every publish until a maintainer blocked its listing.
 */
function disabled(text) {
  try {
    const body = JSON.parse(text);
    return (
      Boolean(body?.block && typeof body.block === "object") ||
      (typeof body?.message === "string" && /repository access blocked/i.test(body.message))
    );
  } catch {
    return false;
  }
}

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

/**
 * How long to wait before asking again, or null when asking again will not
 * help. `text` is the body of a 403, which says whether it is a rate limit.
 */
function retryDelay({ status, headers: h }, text, attempt) {
  let limited = status === 429 || status >= 500;
  if (status === 403) {
    // A 403 is worth waiting out only when it is a rate limit.
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

/**
 * A GET of the API that resolves to an answer: the response, for a 2xx, or
 * null for a repository that is gone.
 */
async function get(path, { token, fetch = globalThis.fetch, wait = pause }) {
  for (let attempt = 0; ; attempt++) {
    let response = null;
    let why;
    try {
      response = await fetch(`${API}${path}`, { headers: headers(token) });
    } catch (e) {
      why = `GitHub could not be reached (${e.message})`;
    }
    if (response?.ok) {
      return response;
    }
    let delay = 1000 * 2 ** attempt;
    if (response) {
      const text = response.status === 403 ? await response.text().catch(() => "") : "";
      if (!response.bodyUsed) {
        await response.body?.cancel().catch(() => {});
      }
      if (GONE.has(response.status) || (response.status === 403 && disabled(text))) {
        return null;
      }
      why = `GitHub answered ${response.status}`;
      delay = retryDelay(response, text, attempt);
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
 * { login, id, type } }, or null if there is none, or GitHub has disabled
 * it. The id stays with a repository through renames and transfers and is
 * never given to another, so listings are tied to it rather than to a name
 * someone else could register.
 */
export async function repoById(repoId, { token, fetch, wait } = {}) {
  const path = `/repositories/${Number(repoId)}`;
  const response = await get(path, { token, fetch, wait });
  return response && describe(await readJSON(response, path), path);
}

/** The same for a repository's full name, owner/name: how a developer finds their repository's id. */
export async function repoByName(fullName, { token, fetch, wait } = {}) {
  const path = `/repos/${fullName}`;
  const response = await get(path, { token, fetch, wait });
  return response && describe(await readJSON(response, path), path);
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
    if (!response) {
      throw new Error(`Repository ${repoId} was not found, is not public, or has been disabled by GitHub`);
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
 * One try at a download: { data }, or { why } when the host did not answer
 * and asking again may help. What is wrong with the release itself throws.
 */
async function downloadOnce(url, { fetch, maxBytes, idleMs, totalMs }) {
  const controller = new AbortController();
  const deadline = Date.now() + totalMs;
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), Math.max(0, Math.min(idleMs, deadline - Date.now())));
  };
  const unanswered = (e) => ({
    why: controller.signal.aborted ? "The download timed out" : `The download failed (${e?.message ?? e})`,
  });
  arm();
  try {
    let response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": "paperly-extensions" },
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (e) {
      return unanswered(e);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 429 || response.status >= 500) {
        return { why: `The download was answered ${response.status}` };
      }
      // A 404, say, for an asset deleted from the release.
      throw new Error(`Download failed: ${response.status}`);
    }
    const reader = response.body?.getReader();
    const chunks = [];
    let total = 0;
    while (reader) {
      let next;
      try {
        next = await reader.read();
      } catch (e) {
        return unanswered(e);
      }
      if (next.done) {
        break;
      }
      arm();
      total += next.value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`The file is larger than ${maxBytes} bytes`);
      }
      chunks.push(next.value);
    }
    return { data: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads at most `maxBytes`, whatever the server claims. No token: release
 * assets of a public repository need none, and the download is redirected to
 * another host that should not see one.
 *
 * The host that serves release assets can fail for a while like the API, and
 * is treated the same: a 5xx, a 429, a dropped connection or a stall is asked
 * again after a pause, and if it persists throws a GitHubError, which stops
 * the build. Taken for a fault of the release, a moment's failure would
 * publish the extension without its newest version, or not at all. A plain
 * Error is something wrong with the release (an asset that is gone, a file
 * over the limit), which rejects that release only.
 */
export async function download(
  url,
  { fetch = globalThis.fetch, wait = pause, maxBytes, idleMs = DOWNLOAD_IDLE_MS, totalMs = DOWNLOAD_TOTAL_MS },
) {
  for (let attempt = 0; ; attempt++) {
    const { data, why } = await downloadOnce(url, { fetch, maxBytes, idleMs, totalMs });
    if (data) {
      return data;
    }
    if (attempt >= RETRIES) {
      throw new GitHubError(`${why} for ${url}`);
    }
    await wait(1000 * 2 ** attempt);
  }
}

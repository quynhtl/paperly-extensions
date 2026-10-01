// Finding an extension's versions: the releases of its public GitHub
// repository that have an .xpi attached.

const API = "https://api.github.com";

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "paperly-extensions",
    ...(token && { Authorization: `Bearer ${token}` }),
  };
}

/**
 * Published releases, newest first, each with the .xpi to check. Drafts and
 * pre-releases are skipped; so is a release with no .xpi, or with more than
 * one (which would leave it unclear what to publish).
 */
export async function listReleases(repo, { token, fetch = globalThis.fetch, count = 10 } = {}) {
  const response = await fetch(`${API}/repos/${repo}/releases?per_page=${count}`, { headers: headers(token) });
  if (response.status === 404) {
    throw new Error(`${repo} was not found, or is not public`);
  }
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${repo}`);
  }
  const releases = await response.json();
  const out = [];
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

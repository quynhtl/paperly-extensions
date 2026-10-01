// Verified publishers: a publisher proves they control a domain by serving
//
//   https://<publisherDomain>/.well-known/paperly-extensions.json
//   { "repoIds": [123456789, ...] }
//
// listing the listing's repository by its numeric id, its repoId. Names are
// not accepted: a user or repository name can be given up and registered
// again by someone else, who would then match a proof that named it, and so
// be shown as the domain's publisher and have new ids under the domain merged
// automatically (see review.mjs). An id stays with its repository.
//
// It is checked again on every publish, so taking the file down takes the
// badge away. Verified says who publishes an extension -- not that the
// extension is safe.

export const WELL_KNOWN_PATH = "/.well-known/paperly-extensions.json";
const MAX_BYTES = 64 * 1024;

/**
 * The body as text, or null as soon as it passes `max` bytes: a server that
 * keeps sending is cut off there rather than read into memory.
 */
async function readCapped(response, max) {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolves to { verified, domain, problem }. Never throws: a domain that
 * cannot be reached simply leaves the publisher unverified, with the reason.
 * The timeout covers the body too, so a server that answers and then stalls
 * is given up on like one that never answers.
 */
export async function verifyPublisher(listing, { fetch = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const domain = listing.publisherDomain;
  if (!domain) {
    return { verified: false, domain: null, problem: null };
  }
  const fail = (problem) => ({ verified: false, domain, problem });
  let text;
  try {
    const response = await fetch(`https://${domain}${WELL_KNOWN_PATH}`, {
      headers: { Accept: "application/json", "User-Agent": "paperly-extensions" },
      // The proof has to come from the domain itself, not from wherever it sends us
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return fail(`https://${domain}${WELL_KNOWN_PATH} answered ${response.status}.`);
    }
    text = await readCapped(response, MAX_BYTES);
  } catch (e) {
    return fail(`https://${domain}${WELL_KNOWN_PATH} could not be fetched (${e?.name === "TimeoutError" ? "timed out" : e?.message}).`);
  }
  if (text === null) {
    return fail(`${WELL_KNOWN_PATH} on ${domain} is larger than ${MAX_BYTES} bytes.`);
  }
  let proof;
  try {
    proof = JSON.parse(text);
  } catch {
    return fail(`${WELL_KNOWN_PATH} on ${domain} is not valid JSON.`);
  }
  // Whole numbers only: whoever runs the domain writes this file, and nothing
  // else is a repository's id.
  const ids = Array.isArray(proof?.repoIds) ? proof.repoIds.filter((id) => Number.isSafeInteger(id)) : [];
  if (!ids.includes(listing.repoId)) {
    return fail(`${WELL_KNOWN_PATH} on ${domain} does not list repository ${listing.repoId} (${listing.repo}) in "repoIds".`);
  }
  return { verified: true, domain, problem: null };
}

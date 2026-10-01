// Verified publishers: a publisher proves they control a domain by serving
//
//   https://<publisherDomain>/.well-known/paperly-extensions.json
//   { "repos": ["owner/name", ...] }
//
// naming the listing's repository. It is checked again on every publish, so
// taking the file down takes the badge away. Verified says who publishes an
// extension -- not that the extension is safe.

export const WELL_KNOWN_PATH = "/.well-known/paperly-extensions.json";
const MAX_BYTES = 64 * 1024;

/**
 * Resolves to { verified, domain, problem }. Never throws: a domain that
 * cannot be reached simply leaves the publisher unverified, with the reason.
 */
export async function verifyPublisher(listing, { fetch = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const domain = listing.publisherDomain;
  if (!domain) {
    return { verified: false, domain: null, problem: null };
  }
  const fail = (problem) => ({ verified: false, domain, problem });
  let response;
  try {
    response = await fetch(`https://${domain}${WELL_KNOWN_PATH}`, {
      headers: { Accept: "application/json", "User-Agent": "paperly-extensions" },
      // The proof has to come from the domain itself, not from wherever it sends us
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return fail(`https://${domain}${WELL_KNOWN_PATH} could not be fetched (${e.name === "TimeoutError" ? "timed out" : e.message}).`);
  }
  if (!response.ok) {
    return fail(`https://${domain}${WELL_KNOWN_PATH} answered ${response.status}.`);
  }
  const text = await response.text();
  if (text.length > MAX_BYTES) {
    return fail(`${WELL_KNOWN_PATH} on ${domain} is larger than ${MAX_BYTES} bytes.`);
  }
  let proof;
  try {
    proof = JSON.parse(text);
  } catch {
    return fail(`${WELL_KNOWN_PATH} on ${domain} is not valid JSON.`);
  }
  const repos = Array.isArray(proof?.repos) ? proof.repos.map((r) => String(r).toLowerCase()) : [];
  if (!repos.includes(listing.repo.toLowerCase())) {
    return fail(`${WELL_KNOWN_PATH} on ${domain} does not list ${listing.repo}.`);
  }
  return { verified: true, domain, problem: null };
}

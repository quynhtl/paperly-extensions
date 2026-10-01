// Mozilla's toolkit version comparison, the one Paperly's add-on manager uses
// to decide whether an extension runs: "1.0" < "1.0.1", "1.0b2" < "1.0",
// "11.*" covers every 11.x, and missing parts count as 0.

function parsePart(part) {
  if (part === "*") {
    return [Infinity, "", 0, ""];
  }
  const match = /^(-?\d*)([^-\d]*)(-?\d*)(.*)$/.exec(part) || ["", "", "", "", ""];
  return [
    match[1] === "" ? 0 : parseInt(match[1], 10),
    match[2],
    match[3] === "" ? 0 : parseInt(match[3], 10),
    match[4],
  ];
}

// An empty string sorts after any other, so "1.0" (no letters) is newer than
// "1.0b".
function compareStrings(a, b) {
  if (a === b) return 0;
  if (a === "") return 1;
  if (b === "") return -1;
  return a < b ? -1 : 1;
}

function compareParts(a, b) {
  const [a1, a2, a3, a4] = parsePart(a);
  const [b1, b2, b3, b4] = parsePart(b);
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  const s = compareStrings(a2, b2);
  if (s) return s;
  if (a3 !== b3) return a3 < b3 ? -1 : 1;
  return compareStrings(a4, b4);
}

/** -1, 0 or 1, like Services.vc.compare. */
export function compareVersions(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const c = compareParts(pa[i] ?? "0", pb[i] ?? "0");
    if (c) return c;
  }
  return 0;
}

/** Whether `appVersion` falls inside an extension's strict min/max. */
export function isCompatible(appVersion, min, max) {
  return compareVersions(appVersion, min) >= 0 && compareVersions(appVersion, max) <= 0;
}

// Mozilla's toolkit version comparison, the one Paperly's add-on manager uses
// to decide whether an extension runs: "1.0" < "1.0.1", "1.0b2" < "1.0",
// "11.*" covers every 11.x, and missing parts count as 0.
//
// A port of ParseVP and CompareVP in Gecko's xpcom/base/nsVersionComparator.cpp,
// down to its corners: anything the two disagree on would let the marketplace
// accept, order or block versions differently from the add-on manager.

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

/**
 * C's strtol as Gecko wraps it: optional leading white space, an optional
 * sign, decimal digits. Returns [value, rest]; with no digits, [0, text]
 * untouched. A value outside int32 becomes 0, as in Gecko's ns_strtol.
 */
function strtol(text) {
  const m = /^[\t\n\v\f\r ]*([+-]?)(\d+)/.exec(text);
  if (!m) {
    return [0, text];
  }
  const value = Number(`${m[1]}${m[2]}`);
  return [value > INT32_MAX || value < INT32_MIN ? 0 : value, text.slice(m[0].length)];
}

/**
 * One dot-separated part as Gecko splits it: a number, a text part, a second
 * number, and whatever follows. A missing text part or rest is null, which
 * sorts after any text, so "1.0" (no letters) is newer than "1.0b".
 */
function parsePart(part) {
  const result = { numA: 0, strB: null, numC: 0, extraD: null };
  if (part === "*") {
    result.numA = INT32_MAX;
    return result;
  }
  let rest;
  [result.numA, rest] = strtol(part);
  if (rest === "") {
    return result;
  }
  if (rest[0] === "+") {
    // "1.0+" is "1.1pre"; whatever follows the "+" is ignored.
    result.numA = (result.numA + 1) | 0;
    result.strB = "pre";
    return result;
  }
  // The text part ends at the first digit, "+" or "-".
  const end = rest.search(/[0-9+-]/);
  if (end < 0) {
    result.strB = rest;
    return result;
  }
  result.strB = rest.slice(0, end);
  let extra;
  [result.numC, extra] = strtol(rest.slice(end));
  result.extraD = extra === "" ? null : extra;
  return result;
}

const compareNumbers = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Any text sorts before no text.
function compareText(a, b) {
  if (a === null) {
    return b === null ? 0 : 1;
  }
  if (b === null) {
    return -1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareParts(a, b) {
  return (
    compareNumbers(a.numA, b.numA) ||
    compareText(a.strB, b.strB) ||
    compareNumbers(a.numC, b.numC) ||
    compareText(a.extraD, b.extraD)
  );
}

/** -1, 0 or 1, like Services.vc.compare. */
export function compareVersions(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const c = compareParts(parsePart(pa[i] ?? ""), parsePart(pb[i] ?? ""));
    if (c) return c;
  }
  return 0;
}

/** Whether `appVersion` falls inside an extension's strict min/max. */
export function isCompatible(appVersion, min, max) {
  return compareVersions(appVersion, min) >= 0 && compareVersions(appVersion, max) <= 0;
}

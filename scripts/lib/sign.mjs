// Signing the index. ECDSA P-256 with SHA-256, through WebCrypto on both
// sides: Node signs here, Paperly verifies with the same API in Gecko. The
// signature is WebCrypto's raw form (r and s, 64 bytes), base64-encoded.
//
// The app holds only the public key. Whoever holds the private key can tell
// every copy of Paperly what to install, so it lives in one place: the
// REGISTRY_SIGNING_KEY secret of this repository's GitHub Actions.
import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const KEY = { name: "ECDSA", namedCurve: "P-256" };
const SIGNATURE = { name: "ECDSA", hash: "SHA-256" };

const toBase64 = (buffer) => Buffer.from(buffer).toString("base64");
const fromBase64 = (text) => Buffer.from(String(text).trim(), "base64");

/** A new key pair: the private key as PKCS#8, the public key as SPKI, both base64. */
export async function generateKeys() {
  const pair = await subtle.generateKey(KEY, true, ["sign", "verify"]);
  return {
    privateKey: toBase64(await subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: toBase64(await subtle.exportKey("spki", pair.publicKey)),
  };
}

export async function publicKeyOf(privateKey) {
  // WebCrypto cannot derive a public key from a private one directly, but a
  // JWK export of the private key carries x and y.
  const key = await subtle.importKey("pkcs8", fromBase64(privateKey), KEY, true, ["sign"]);
  const { kty, crv, x, y } = await subtle.exportKey("jwk", key);
  const pub = await subtle.importKey("jwk", { kty, crv, x, y }, KEY, true, ["verify"]);
  return toBase64(await subtle.exportKey("spki", pub));
}

export async function sign(data, privateKey) {
  const key = await subtle.importKey("pkcs8", fromBase64(privateKey), KEY, false, ["sign"]);
  return toBase64(await subtle.sign(SIGNATURE, key, data));
}

export async function verify(data, signature, publicKey) {
  const key = await subtle.importKey("spki", fromBase64(publicKey), KEY, false, ["verify"]);
  return subtle.verify(SIGNATURE, key, fromBase64(signature), data);
}

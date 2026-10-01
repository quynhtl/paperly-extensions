#!/usr/bin/env node
// Makes the key pair that signs the index. Run it once, when setting up the
// marketplace (or to replace a key that may have leaked):
//
//   node scripts/keygen.mjs
//
// It prints both keys and writes nothing to disk. The private key goes into
// this repository's REGISTRY_SIGNING_KEY secret and nowhere else; the public
// key goes into Paperly, which trusts no index it cannot verify with it.
import { generateKeys } from "./lib/sign.mjs";

const { privateKey, publicKey } = await generateKeys();
console.log(`Private key (GitHub > Settings > Secrets and variables > Actions > REGISTRY_SIGNING_KEY):

${privateKey}

Public key (paperly-client: defaults/preferences/zotero.js,
extensions.zotero.paperlyExtensions.publicKey):

${publicKey}
`);
